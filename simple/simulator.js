var Simulator = (function () {
    'use strict';

    var PRESSURE_JACOBI_ITERATIONS = 2;

    var FRAMES_TO_SIMULATE = 30.0; //how many frames to simulate the area induced by each splat for
    var DELTA_TIME = 1.0/FRAMES_TO_SIMULATE; //we use a constant timestep for simulation consistency
    
    function Simulator (wgl, shaderSources, resolutionWidth, resolutionHeight) {
        
        this.wgl = wgl;

        wgl.getExtension('OES_texture_float');
        wgl.getExtension('OES_texture_float_linear');

        const halfFloatExt = wgl.getExtension('OES_texture_half_float');
        const halfFloatLinearExt = wgl.getExtension('OES_texture_half_float_linear');
        
        this.simulationTextureType = halfFloatExt.HALF_FLOAT_OES;

        this.resolutionWidth = resolutionWidth;
        this.resolutionHeight = resolutionHeight;

        this.fluidity = 0.8;

        //the splat areas that we're currently still simulating
        //more recent are at the front of the array
        

        //////////////////////////////////////////////////
        // create shader programs

        this.splatProgram = wgl.createProgram(
            shaderSources['shaders/splat.vert'], shaderSources['shaders/splat.frag']);

        this.velocitySplatProgram = wgl.createProgram(
            '#define VELOCITY \n' + shaderSources['shaders/splat.vert'], '#define VELOCITY \n' + shaderSources['shaders/splat.frag']);

        this.advectProgram = wgl.createProgram(
            shaderSources['shaders/fullscreen.vert'], shaderSources['shaders/advect.frag']);

        this.divergenceProgram = wgl.createProgram(
            shaderSources['shaders/fullscreen.vert'], shaderSources['shaders/divergence.frag']);

        this.jacobiProgram = wgl.createProgram(
            shaderSources['shaders/fullscreen.vert'], shaderSources['shaders/jacobi.frag']);

        this.subtractProgram = wgl.createProgram(
            shaderSources['shaders/fullscreen.vert'], shaderSources['shaders/subtract.frag']);

        this.copyProgram = wgl.createProgram(
            shaderSources['shaders/fullscreen.vert'], shaderSources['shaders/output.frag']);


        ///////////////////////////////////////////////
        // create buffers


        this.splatPositionsBuffer = wgl.createBuffer();
        this.splatVelocitiesBuffer = wgl.createBuffer();

        this.simulationFramebuffer = wgl.createFramebuffer();

        //create textures

        this.paintTexture = wgl.buildTexture(wgl.RGBA, wgl.FLOAT, this.resolutionWidth, this.resolutionHeight, null, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.LINEAR, wgl.LINEAR);
        this.paintTextureTemp = wgl.buildTexture(wgl.RGBA, wgl.FLOAT, this.resolutionWidth, this.resolutionHeight, null, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.LINEAR, wgl.LINEAR);

        this.velocityTexture = wgl.buildTexture(wgl.RGBA, this.simulationTextureType, this.resolutionWidth, this.resolutionHeight, null, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.LINEAR, wgl.LINEAR);
        this.velocityTextureTemp = wgl.buildTexture(wgl.RGBA, this.simulationTextureType, this.resolutionWidth, this.resolutionHeight, null, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.LINEAR, wgl.LINEAR);

        this.divergenceTexture = wgl.buildTexture(wgl.RGBA, this.simulationTextureType, this.resolutionWidth, this.resolutionHeight, null, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.NEAREST, wgl.NEAREST);
        this.pressureTexture = wgl.buildTexture(wgl.RGBA, this.simulationTextureType, this.resolutionWidth, this.resolutionHeight, null, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.NEAREST, wgl.NEAREST);

        
        this.pressureTextureTemp = wgl.buildTexture(wgl.RGBA, this.simulationTextureType, this.resolutionWidth, this.resolutionHeight, null, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.NEAREST, wgl.NEAREST);

        this.clearTextures([this.paintTexture, this.paintTextureTemp, this.velocityTexture, this.velocityTextureTemp, this.divergenceTexture, this.pressureTexture, this.pressureTextureTemp]);
        
        this.advect = (function (velocityTexture, dataTexture, targetTexture, deltaTime, dissipation) {
            
            var advectDrawState = wgl.createDrawState()
            .bindFramebuffer(this.simulationFramebuffer)
            .viewport(0,0,Config.W,Config.H)
            .useProgram(this.advectProgram)
            .uniform2f('u_resolution',Config.W,Config.H)
            .uniform1f('u_dissipation',dissipation)
            .uniform1f('u_deltaTime',deltaTime)
            .uniformTexture('u_velocityTexture', 0, wgl.TEXTURE_2D, velocityTexture)
            .uniformTexture('u_inputTexture', 1, wgl.TEXTURE_2D, dataTexture)
            .vertexAttribPointer(quadVertexBuffer, this.advectProgram.getAttribLocation('a_position'), 2, wgl.FLOAT, false, 0, 0);
            wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, targetTexture, 0);
            wgl.drawArrays(advectDrawState, wgl.TRIANGLE_STRIP,0,4);
        }).bind(this);
        
    }

    Simulator.prototype.clearTextures = function (textures) {
        var wgl = this.wgl;

        for (var i = 0; i < textures.length; ++i) {
            wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, textures[i], 0);

            wgl.clear(
                wgl.createClearState().bindFramebuffer(this.simulationFramebuffer),
                wgl.COLOR_BUFFER_BIT);
        }
    };

    Simulator.prototype.clear = function () {
        this.clearTextures([this.paintTexture, this.paintTextureTemp]);
    };

    Simulator.prototype.splat = function(brush, zThreshold, width, height, splatColor, splatRadius, velocityScale) {
        

        var wgl = this.wgl;

        var splatPaintDrawState = wgl.createDrawState()
            .bindFramebuffer(this.simulationFramebuffer)
            .viewport(0,0,Config.W,Config.H)
            .enable(wgl.BLEND)
            .blendEquation(wgl.FUNC_ADD)
            .blendFuncSeparate(wgl.SRC_ALPHA, wgl.ONE_MINUS_SRC_ALPHA, wgl.ONE, wgl.ONE)
            .vertexAttribPointer(brush.splatCoordinatesBuffer, this.splatProgram.getAttribLocation('a_splatCoordinates'), 4, wgl.FLOAT, wgl.FALSE, 0, 0)
            .bindIndexBuffer(brush.splatIndexBuffer)
            .useProgram(this.splatProgram)
            .uniform2f('u_paintingDimensions',Config.W,Config.H)
            .uniform1f('u_splatRadius', splatRadius)
            .uniform4f('u_splatColor', splatColor[0], splatColor[1], splatColor[2], splatColor[3])
            .uniformTexture('u_positionsTexture', 0, wgl.TEXTURE_2D, brush.positionsTexture)
            .uniformTexture('u_previousPositionsTexture', 1, wgl.TEXTURE_2D, brush.previousPositionsTexture)
            .uniform1f('u_zThreshold', zThreshold);

        wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.paintTexture, 0);
        wgl.drawElements(splatPaintDrawState, wgl.TRIANGLES, brush.splatIndexCount * brush.bristleCount / brush.maxBristleCount, wgl.UNSIGNED_SHORT, 0);

        wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.velocityTexture, 0);

        var splatVelocityDrawState = wgl.createDrawState()
            .bindFramebuffer(this.simulationFramebuffer)
            .viewport(0,0,Config.W,Config.H)
            .enable(wgl.BLEND)
            .blendEquation(wgl.FUNC_ADD)
            .blendFuncSeparate(wgl.ONE, wgl.ONE, wgl.ZERO, wgl.ZERO)
            .vertexAttribPointer(brush.splatCoordinatesBuffer, this.splatProgram.getAttribLocation('a_splatCoordinates'), 4, wgl.FLOAT, wgl.FALSE, 0, 0)
            .bindIndexBuffer(brush.splatIndexBuffer)
            .useProgram(this.velocitySplatProgram)
            .uniform2f('u_paintingDimensions',Config.W,Config.H)
            .uniform1f('u_splatRadius', splatRadius)
            .uniformTexture('u_positionsTexture', 0, wgl.TEXTURE_2D, brush.positionsTexture)
            .uniformTexture('u_previousPositionsTexture', 1, wgl.TEXTURE_2D, brush.previousPositionsTexture)
            .uniformTexture('u_velocitiesTexture', 2, wgl.TEXTURE_2D, brush.velocitiesTexture)
            .uniformTexture('u_previousVelocitiesTexture', 3, wgl.TEXTURE_2D, brush.previousVelocitiesTexture)
            .uniform1f('u_zThreshold', zThreshold)
            .uniform1f('u_velocityScale', velocityScale);

        wgl.drawElements(splatVelocityDrawState, wgl.TRIANGLES, brush.splatIndexCount * brush.bristleCount / brush.maxBristleCount, wgl.UNSIGNED_SHORT, 0);

    };


    Simulator.prototype.simulate = function() {
        
        var wgl = this.wgl;

        // advect velocity and paint
    
        //compute divergence for pressure projection

        var divergenceDrawState = wgl.createDrawState()
            
            .bindFramebuffer(this.simulationFramebuffer)
            .viewport(0,0,Config.W,Config.H)
            .useProgram(this.divergenceProgram)
            .uniform2f('u_resolution',Config.W,Config.H)
            .uniformTexture('u_velocityTexture', 0, wgl.TEXTURE_2D, this.velocityTexture)
            .vertexAttribPointer(quadVertexBuffer, this.divergenceProgram.getAttribLocation('a_position'), 2, wgl.FLOAT, false, 0, 0);


        wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.divergenceTexture, 0);
        
        wgl.drawArrays(divergenceDrawState, wgl.TRIANGLE_STRIP, 0, 4);
        
        
        //compute pressure via jacobi iteration

        var jacobiDrawState = wgl.createDrawState()
            .bindFramebuffer(this.simulationFramebuffer)
            .viewport(0,0,Config.W,Config.H)
            .useProgram(this.jacobiProgram)
            .uniform2f('u_resolution',Config.W,Config.H)
            .uniformTexture('u_divergenceTexture', 1, wgl.TEXTURE_2D, this.divergenceTexture)
            .vertexAttribPointer(quadVertexBuffer, this.jacobiProgram.getAttribLocation('a_position'), 2, wgl.FLOAT, false, 0, 0);


        wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.pressureTexture, 0);
            wgl.clear(
                wgl.createClearState().bindFramebuffer(this.simulationFramebuffer),
                wgl.COLOR_BUFFER_BIT);
        
        for (var i=0; i < PRESSURE_JACOBI_ITERATIONS; i++) {
            wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.pressureTextureTemp, 0);
            jacobiDrawState.uniformTexture('u_pressureTexture', 0, wgl.TEXTURE_2D, this.pressureTexture);
            
            wgl.drawArrays(jacobiDrawState, wgl.TRIANGLE_STRIP, 0, 4);
            
            Utils.swap(this, 'pressureTexture', 'pressureTextureTemp');
        }
        
        //subtract pressure gradient from velocity

        var subtractDrawState = wgl.createDrawState()
            .bindFramebuffer(this.simulationFramebuffer)
            .viewport(0,0,Config.W,Config.H)
            .useProgram(this.subtractProgram)
            .uniform2f('u_resolution',Config.W,Config.H)
            .uniformTexture('u_pressureTexture', 0, wgl.TEXTURE_2D, this.pressureTexture)
            .uniformTexture('u_velocityTexture', 1, wgl.TEXTURE_2D, this.velocityTexture)
            .vertexAttribPointer(quadVertexBuffer, this.subtractProgram.getAttribLocation('a_position'), 2, wgl.FLOAT, false, 0, 0);
            
        wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.velocityTextureTemp, 0);
            
        wgl.drawArrays(subtractDrawState, wgl.TRIANGLE_STRIP, 0, 4);
            
        Utils.swap(this,'velocityTexture','velocityTextureTemp');
    
        //advect paint
        this.advect(this.velocityTexture, this.paintTexture, this.paintTextureTemp, DELTA_TIME, 1.0);
        Utils.swap(this, 'paintTexture', 'paintTextureTemp');
    
        //advect velocity
        this.advect(this.velocityTexture, this.velocityTexture, this.velocityTextureTemp, DELTA_TIME, this.fluidity);
        Utils.swap(this, 'velocityTexture', 'velocityTextureTemp');
    
        // this.clearTextures(this.velocityTexture, this.velocityTextureTemp);
    };

    return Simulator;

}());
