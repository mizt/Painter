var Paint = (function () {
    'use strict';

    var InteractionMode = {
        NONE: 0,
        PAINTING: 1
    };

    //brush parameters
    var MAX_BRISTLE_COUNT = 100;
    var MIN_BRISTLE_COUNT = 10;
    var MIN_BRUSH_SCALE = 10;
    var MAX_BRUSH_SCALE = 75;
    var BRUSH_HEIGHT = 2.0; //how high the brush is over the canvas - this is scaled with the brushScale
    var Z_THRESHOLD = 0.13333; //this is scaled with the brushScale

    //splatting parameters
    var SPLAT_VELOCITY_SCALE = 0.14;
    var SPLAT_RADIUS = 0.05;

    //for thin brush (fewest bristles)
    var THIN_MIN_ALPHA = 0.002;
    var THIN_MAX_ALPHA = 0.08;

    //for thick brush (most bristles)
    var THICK_MIN_ALPHA = 0.002;
    var THICK_MAX_ALPHA = 0.025;

    //rendering parameters
    var BACKGROUND_GRAY = 0.7;
    var NORMAL_SCALE = 7.0;
    var ROUGHNESS = 0.075;
    var F0 = 0.05;
    var SPECULAR_SCALE = 0.5;
    var DIFFUSE_SCALE = 0.15;
    var LIGHT_DIRECTION = [0,1,1];
    
    function makeOrthographicMatrix(left,right,bottom,top,near,far) {
        const matrix = Utils.identityMatrix();
        matrix[0] = 2/(right-left);
        matrix[5] = 2/(top-bottom);
        matrix[10] = -2/(far-near);
        matrix[12] = -(right+left)/(right-left);
        matrix[13] = -(top+bottom)/(top-bottom);
        matrix[14] = -(far+near)/(far-near);
        return matrix;
    }
    
    function Paint (canvas, wgl) {
        this.canvas = canvas;
        this.wgl = wgl;

        WrappedGL.loadTextFiles([
            'shaders/splat.vert','shaders/splat.frag',
            'shaders/fullscreen.vert',
            'shaders/advect.frag',
            'shaders/divergence.frag',
            'shaders/jacobi.frag',
            'shaders/subtract.frag',
            'shaders/project.frag',
            'shaders/distanceconstraint.frag',
            'shaders/planeconstraint.frag',
            'shaders/bendingconstraint.frag',
            'shaders/setbristles.frag',
            'shaders/updatevelocity.frag',
            'shaders/brush.vert','shaders/brush.frag',
            'shaders/painting.vert','shaders/painting.frag',
            'shaders/output.frag',
        ], start.bind(this));

        function start(shaderSources) {

            this.framebuffer = wgl.createFramebuffer();

            this.paintingProgram = wgl.createProgram(
                shaderSources['shaders/painting.vert'], shaderSources['shaders/painting.frag']);
            
            this.brushProgram = wgl.createProgram(
                shaderSources['shaders/brush.vert'], shaderSources['shaders/brush.frag'], { 'a_position': 0 });

            this.outputProgram = wgl.createProgram(
                shaderSources['shaders/fullscreen.vert'], shaderSources['shaders/output.frag'], { 'a_position': 0 });
            

            // simulation resolution = painting resolution * resolution scale
            this.resolutionScale = 1.0;

            this.simulator = new Simulator(wgl,shaderSources,Config.W,Config.H);

            // whether the user has moved their mouse at least once and we thus have a valid brush position
            this.brushInitialized = false; 

            this.brushX = 0;
            this.brushY = 0;

            this.brushScale = 50;
            this.brush = new Brush(wgl, shaderSources, MAX_BRISTLE_COUNT);

            this.brushViewer = new BrushViewer(wgl,this.brushProgram,0,0,200,300);
            this.brushViewer.bottom = 300;

            this.mainProjectionMatrix = makeOrthographicMatrix(0.0,Config.W,0.0,Config.H,-5000.0,5000.0);
            
            this.canvasTexture        = wgl.buildTexture(wgl.RGBA,wgl.UNSIGNED_BYTE,Config.W,Config.H, null,wgl.CLAMP_TO_EDGE,wgl.CLAMP_TO_EDGE,wgl.LINEAR,wgl.LINEAR);
            this.tempCanvasTexture    = wgl.buildTexture(wgl.RGBA,wgl.UNSIGNED_BYTE,Config.W,Config.H, null,wgl.CLAMP_TO_EDGE,wgl.CLAMP_TO_EDGE,wgl.LINEAR,wgl.LINEAR);
            this.blurredCanvasTexture = wgl.buildTexture(wgl.RGBA,wgl.UNSIGNED_BYTE,Config.W,Config.H, null,wgl.CLAMP_TO_EDGE,wgl.CLAMP_TO_EDGE,wgl.LINEAR,wgl.LINEAR);
              
            this.mouseX = 0;
            this.mouseY = 0;

            this.spaceDown = false;

            canvas.addEventListener('mousemove', this.onMouseMove.bind(this));
            canvas.addEventListener('mousedown', this.onMouseDown.bind(this));
            document.addEventListener('mouseup', this.onMouseUp.bind(this));
            canvas.addEventListener('mouseover', this.onMouseOver.bind(this));

            this.interactionState = InteractionMode.NONE;

            // draw
            setInterval((this.update).bind(this),30);
            this.update();
        }
    }

  
    Paint.prototype.update = function() {
      
      if(this.brushInitialized) {
        
        const wgl = this.wgl;
        const canvas = this.canvas;
        const simulationFramebuffer = this.simulationFramebuffer;

        //update brush
        this.brush.update(this.brushX, this.brushY, BRUSH_HEIGHT * this.brushScale, this.brushScale);
      
        //splat into paint and velocity textures

        if(this.interactionState === InteractionMode.PAINTING) {
          
            var splatRadius = SPLAT_RADIUS * this.brushScale;

            var splatColor = [1,0,0];

            //we scale alpha based on the number of bristles
            var bristleT = (this.brush.bristleCount - MIN_BRISTLE_COUNT) / (MAX_BRISTLE_COUNT - MIN_BRISTLE_COUNT);

            var minAlpha = Utils.mix(THIN_MIN_ALPHA, THICK_MIN_ALPHA, bristleT);
            var maxAlpha = Utils.mix(THIN_MAX_ALPHA, THICK_MAX_ALPHA, bristleT);

            var alpha = Utils.mix(minAlpha, maxAlpha, 0.8);

            splatColor[3] = alpha;

            var splatVelocityScale = SPLAT_VELOCITY_SCALE * splatColor[3] * this.resolutionScale;

            // splat paint
            this.simulator.splat(this.brush, Z_THRESHOLD * this.brushScale, Config.W,Config.H, splatColor, splatRadius, splatVelocityScale);

        }

        this.simulator.simulate();

        //draw painting into texture

        wgl.framebufferTexture2D(this.framebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.canvasTexture, 0);
        var clearState = wgl.createClearState()
            .bindFramebuffer(this.framebuffer)
            .clearColor(BACKGROUND_GRAY, BACKGROUND_GRAY, BACKGROUND_GRAY, 1.0);

        wgl.clear(clearState,wgl.COLOR_BUFFER_BIT|wgl.DEPTH_BUFFER_BIT);

        var paintingProgram = this.paintingProgram;

        var paintingDrawState = wgl.createDrawState()
            .bindFramebuffer(this.framebuffer)
            .vertexAttribPointer(quadVertexBuffer, paintingProgram.getAttribLocation('a_position'), 2, wgl.FLOAT, false, 0, 0)
            .viewport(0,0,Config.W,Config.H)
            .useProgram(paintingProgram)
            .uniform2f('u_resolution',Config.W,Config.H)
            .uniform1f('u_normalScale', NORMAL_SCALE)
            .uniform1f('u_roughness', ROUGHNESS)
            .uniform1f('u_diffuseScale', DIFFUSE_SCALE)
            .uniform1f('u_specularScale', SPECULAR_SCALE)
            .uniform1f('u_F0',F0)
            .uniform3f('u_lightDirection', LIGHT_DIRECTION[0], LIGHT_DIRECTION[1], LIGHT_DIRECTION[2])
            .uniformTexture('u_paintTexture', 0, wgl.TEXTURE_2D, this.simulator.paintTexture);

        wgl.drawArrays(paintingDrawState, wgl.TRIANGLE_STRIP,0,4);

        //output painting to screen
        var outputDrawState = wgl.createDrawState()
          .viewport(0, 0, Config.W,Config.H)
          .useProgram(this.outputProgram)
          .uniformTexture('u_input', 0, wgl.TEXTURE_2D, this.canvasTexture)
          .vertexAttribPointer(quadVertexBuffer, 0,2, wgl.FLOAT, wgl.FALSE, 0, 0);

        wgl.drawArrays(outputDrawState, wgl.TRIANGLE_STRIP,0,4);

        // draw brush to screen
        // we draw the brush if we're painting or you would start painting on click
        if (this.interactionState === InteractionMode.PAINTING) { 
            var brushDrawState = wgl.createDrawState()
                .bindFramebuffer(null)
                .viewport(0, 0, Config.W,Config.H)
                .vertexAttribPointer(this.brush.brushTextureCoordinatesBuffer, 0, 2, wgl.FLOAT, wgl.FALSE, 0, 0)
                .useProgram(this.brushProgram)
                .bindIndexBuffer(this.brush.brushIndexBuffer)
                .uniform4f('u_color', 0.6, 0.6, 0.6, 1.0)
                .uniformMatrix4fv('u_projectionViewMatrix', false, this.mainProjectionMatrix)
                .enable(wgl.DEPTH_TEST)
                .enable(wgl.BLEND)
                .blendFunc(wgl.DST_COLOR, wgl.ZERO)
                .uniformTexture('u_positionsTexture', 0, wgl.TEXTURE_2D, this.brush.positionsTexture);
            wgl.drawElements(brushDrawState, wgl.LINES, this.brush.indexCount * this.brush.bristleCount / this.brush.maxBristleCount, wgl.UNSIGNED_SHORT, 0);
        }

        this.brushViewer.draw(this.brushX, this.brushY, this.brush);
        
      }
    };

    Paint.prototype.onMouseMove = function(event) {
        event.preventDefault();
        var position = Utils.getMousePosition(event,this.canvas);
        this.mouseX = this.brushX = position.x;
        this.mouseY = this.brushY = this.canvas.height - position.y;;
        if(!this.brushInitialized) {
            this.brush.initialize(this.brushX, this.brushY, BRUSH_HEIGHT * this.brushScale, this.brushScale);
            this.brushInitialized = true;
        }
    };

    Paint.prototype.onMouseDown = function(event) {
        event.preventDefault();
        var position = Utils.getMousePosition(event,this.canvas);
        this.mouseX = position.x;
        this.mouseY = this.canvas.height-position.y;
        this.interactionState = InteractionMode.PAINTING;
    };

    Paint.prototype.onMouseUp = function(event) {
        event.preventDefault();
        var position = Utils.getMousePosition(event,this.canvas);
        this.interactionState = InteractionMode.NONE;
    };

    Paint.prototype.onMouseOver = function(event) {
        event.preventDefault();
        var position = Utils.getMousePosition(event, this.canvas);
        this.brushX = position.x;
        this.brushY = this.canvas.height-position.y;
        this.brush.initialize(this.brushX,this.brushY, BRUSH_HEIGHT*this.brushScale,this.brushScale);
        this.brushInitialized = true;
    };

    return Paint;
    
}());
