const Simulator = (function () {

    var FLUIDITY = 0.8;
    var PRESSURE_JACOBI_ITERATIONS = 2;
    var FRAMES_TO_SIMULATE = 30.0; //how many frames to simulate the area induced by each splat for
    var DELTA_TIME = 1.0/FRAMES_TO_SIMULATE; //we use a constant timestep for simulation consistency
    
    function Simulator(wgl, shaderSources) {
        
        this.wgl = wgl;
        
        const RGBA = wgl.RGBA;
        const FLOAT = wgl.FLOAT;
        const CLAMP_TO_EDGE = wgl.CLAMP_TO_EDGE;
        const LINEAR = wgl.LINEAR;
        const NEAREST = wgl.NEAREST;
        
        wgl.getExtension("OES_texture_float");
        wgl.getExtension("OES_texture_float_linear");

        const halfFloatExt = wgl.getExtension('OES_texture_half_float');
        const halfFloatLinearExt = wgl.getExtension('OES_texture_half_float_linear');
        
        this.simulationTextureType = halfFloatExt.HALF_FLOAT_OES;

        //the splat areas that we're currently still simulating
        //more recent are at the front of the array

        //////////////////////////////////////////////////
        // create shader programs

        this.splatProgram = wgl.createProgram(shaderSources['shaders/splat.vert'], shaderSources['shaders/splat.frag']);
        this.velocitySplatProgram = wgl.createProgram('#define VELOCITY \n' + shaderSources['shaders/splat.vert'], '#define VELOCITY \n' + shaderSources['shaders/splat.frag']);
        this.advectProgram = wgl.createProgram(shaderSources['shaders/fullscreen.vert'], shaderSources['shaders/advect.frag']);
        this.divergenceProgram = wgl.createProgram(shaderSources['shaders/fullscreen.vert'], shaderSources['shaders/divergence.frag']);
        this.jacobiProgram = wgl.createProgram(shaderSources['shaders/fullscreen.vert'], shaderSources['shaders/jacobi.frag']);
        this.subtractProgram = wgl.createProgram(shaderSources['shaders/fullscreen.vert'], shaderSources['shaders/subtract.frag']);
        this.copyProgram = wgl.createProgram(shaderSources['shaders/fullscreen.vert'], shaderSources['shaders/output.frag']);

        ///////////////////////////////////////////////
        // create buffers

        this.splatPositionsBuffer = wgl.createBuffer();
        this.splatVelocitiesBuffer = wgl.createBuffer();
        this.simulationFramebuffer = wgl.createFramebuffer();

        //create textures
        
        this.paintTexture = [
            wgl.buildTexture(RGBA,FLOAT,Config.W,Config.H,null,CLAMP_TO_EDGE,CLAMP_TO_EDGE,LINEAR,LINEAR),
            wgl.buildTexture(RGBA,FLOAT,Config.W,Config.H,null,CLAMP_TO_EDGE,CLAMP_TO_EDGE,LINEAR,LINEAR)
        ];
        
        this.velocityTexture = [
            wgl.buildTexture(RGBA,this.simulationTextureType,Config.W,Config.H,null,CLAMP_TO_EDGE,CLAMP_TO_EDGE,LINEAR,LINEAR),
            wgl.buildTexture(RGBA,this.simulationTextureType,Config.W,Config.H,null,CLAMP_TO_EDGE,CLAMP_TO_EDGE,LINEAR,LINEAR)
        ];
        
        this.divergenceTexture = wgl.buildTexture(RGBA,this.simulationTextureType,Config.W,Config.H,null,CLAMP_TO_EDGE,CLAMP_TO_EDGE,NEAREST,NEAREST);
        
        this.pressureTexture = [
            wgl.buildTexture(RGBA,this.simulationTextureType,Config.W,Config.H,null,CLAMP_TO_EDGE,CLAMP_TO_EDGE,NEAREST,NEAREST),
            wgl.buildTexture(RGBA,this.simulationTextureType,Config.W,Config.H,null,CLAMP_TO_EDGE,CLAMP_TO_EDGE,NEAREST,NEAREST)
        ];

        this.clearTextures([this.paintTexture[0], this.paintTexture[1], this.velocityTexture[0], this.velocityTexture[1], this.divergenceTexture, this.pressureTexture[0], this.pressureTexture[1]]);
        
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
            .vertexAttribPointer(quadVertexBuffer, this.advectProgram.getAttribLocation('a_position'),2,FLOAT,false,0,0);
            wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, targetTexture, 0);
            wgl.drawArrays(advectDrawState, wgl.TRIANGLE_STRIP,0,4);
        }).bind(this);
        
    }

    Simulator.prototype.clearTextures = function (textures) {
        var wgl = this.wgl;
        for (var i=0; i<textures.length; i++) {
            wgl.framebufferTexture2D(this.simulationFramebuffer,wgl.FRAMEBUFFER,wgl.COLOR_ATTACHMENT0,wgl.TEXTURE_2D,textures[i],0);
            wgl.clear(wgl.createClearState().bindFramebuffer(this.simulationFramebuffer),wgl.COLOR_BUFFER_BIT);
        }
    };

    /*
    Simulator.prototype.clear = function () {
        console.log("clear");
        this.clearTextures([this.paintTexture[0], this.paintTexture[1]);
    };
    */
    
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
        wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.paintTexture[0], 0);
        wgl.drawElements(splatPaintDrawState, wgl.TRIANGLES, brush.splatIndexCount * brush.bristleCount / brush.maxBristleCount, wgl.UNSIGNED_SHORT, 0);
        
        
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
        wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.velocityTexture[0], 0);
        wgl.drawElements(splatVelocityDrawState, wgl.TRIANGLES, brush.splatIndexCount * brush.bristleCount / brush.maxBristleCount, wgl.UNSIGNED_SHORT, 0);

    };

    Simulator.prototype.simulate = function() {
        
        var wgl = this.wgl;

        // advect velocity and paint
        // compute divergence for pressure projection

        var divergenceDrawState = wgl.createDrawState()
            .bindFramebuffer(this.simulationFramebuffer)
            .viewport(0,0,Config.W,Config.H)
            .useProgram(this.divergenceProgram)
            .uniform2f('u_resolution',Config.W,Config.H)
            .uniformTexture('u_velocityTexture',0,wgl.TEXTURE_2D, this.velocityTexture[0])
            .vertexAttribPointer(quadVertexBuffer,this.divergenceProgram.getAttribLocation('a_position'),2,wgl.FLOAT,false,0,0);
        wgl.framebufferTexture2D(this.simulationFramebuffer,wgl.FRAMEBUFFER,wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.divergenceTexture, 0);
        wgl.drawArrays(divergenceDrawState, wgl.TRIANGLE_STRIP, 0, 4);
        
        //compute pressure via jacobi iteration

        var jacobiDrawState = wgl.createDrawState()
            .bindFramebuffer(this.simulationFramebuffer)
            .viewport(0,0,Config.W,Config.H)
            .useProgram(this.jacobiProgram)
            .uniform2f("u_resolution",Config.W,Config.H)
            .uniformTexture("u_divergenceTexture",1,wgl.TEXTURE_2D,this.divergenceTexture)
            .vertexAttribPointer(quadVertexBuffer,this.jacobiProgram.getAttribLocation("a_position"),2,wgl.FLOAT,false,0,0);
        wgl.framebufferTexture2D(this.simulationFramebuffer,wgl.FRAMEBUFFER,wgl.COLOR_ATTACHMENT0,wgl.TEXTURE_2D,this.pressureTexture[0],0);
        wgl.clear(wgl.createClearState().bindFramebuffer(this.simulationFramebuffer),wgl.COLOR_BUFFER_BIT);
        
        for(var i=0; i<PRESSURE_JACOBI_ITERATIONS; i++) {
            wgl.framebufferTexture2D(this.simulationFramebuffer,wgl.FRAMEBUFFER,wgl.COLOR_ATTACHMENT0,wgl.TEXTURE_2D,this.pressureTexture[1],0);
            jacobiDrawState.uniformTexture("u_pressureTexture",0,wgl.TEXTURE_2D, this.pressureTexture[0]);
            wgl.drawArrays(jacobiDrawState,wgl.TRIANGLE_STRIP,0,4);
            Utils.swap(this.pressureTexture,0,1);
        }
        
        //subtract pressure gradient from velocity

        var subtractDrawState = wgl.createDrawState()
            .bindFramebuffer(this.simulationFramebuffer)
            .viewport(0,0,Config.W,Config.H)
            .useProgram(this.subtractProgram)
            .uniform2f("u_resolution",Config.W,Config.H)
            .uniformTexture("u_pressureTexture",0,wgl.TEXTURE_2D,this.pressureTexture[0])
            .uniformTexture("u_velocityTexture",1,wgl.TEXTURE_2D,this.velocityTexture[0])
            .vertexAttribPointer(quadVertexBuffer,this.subtractProgram.getAttribLocation("a_position"),2,wgl.FLOAT,false,0,0);
        wgl.framebufferTexture2D(this.simulationFramebuffer,wgl.FRAMEBUFFER,wgl.COLOR_ATTACHMENT0,wgl.TEXTURE_2D,this.velocityTexture[1],0);
        wgl.drawArrays(subtractDrawState,wgl.TRIANGLE_STRIP,0,4);
        Utils.swap(this.velocityTexture,0,1);
    
        //advect paint
        this.advect(this.velocityTexture[0], this.paintTexture[0], this.paintTexture[1], DELTA_TIME, 1.0);
        Utils.swap(this.paintTexture,0,1);
    
        //advect velocity
        this.advect(this.velocityTexture[0], this.velocityTexture[0], this.velocityTexture[1], DELTA_TIME,FLUIDITY);
        this.velocityTexture = [this.velocityTexture[1],this.velocityTexture[0]];

        //const tmp = this.velocityTexture[0];
        //this.velocityTexture[0] = this.velocityTexture[1];
        //this.velocityTexture[1] = tmp;

        //Utils.swapTexture(this.velocityTexture[0],this.velocityTexture[1])
        
        // this.clearTextures(this.velocityTexture, this.velocityTextureTemp);
    };

    return Simulator;

}());
