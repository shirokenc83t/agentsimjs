function plant_obj(id,dimension,position_x,position_z,scene){

	//fixed dimension solar_panel

   this.solar_panel_dim=50; 

   this.panel_number=dimension/this.solar_panel_dim;

   this.string_size=this.panel_number/2;

   this.id=id;
   this.start_x=position_x;
   this.start_y=(dimension/2);
   this.start_z=position_z;
   this.dimension=dimension;

   this.local_c_x=this.start_x+ dimension + 100;
   this.local_c_y=2;
   this.local_c_z=this.start_z + dimension;
   this.line_numb;
   this.line_numb_array=[];

   this.plant_id="plant" + this.id + "_console";

  this.cam_p_x=this.start_x+ this.dimension/2;
		this.cam_p_z=this.start_z + this.dimension;
		this.cam_p_y=50/2 - 2;

   this.build_plant=function(){

   			for(var i=0;i<this.panel_number;i++){

   					for(var j=0;j<this.panel_number;j++){

   					 var pos_x=(i*this.solar_panel_dim + 20) + this.start_x;
   					 var pos_z=(j*this.solar_panel_dim + 20) + this.start_z;

   					 var solar_p = new solar_panel(1,this.solar_panel_dim,pos_x,pos_z);
      				 solar_p.spawn();

      				}

   			}
	this.build_local_monitoring( this.start_x,this.start_z,this.dimension);
   		
   };

   


this.build_local_monitoring=function(start_x,start_z,dimension){

   		var geometry_cam = new THREE.BoxGeometry( 50/9, 50/2, 50/10);
		var material_cam = new THREE.MeshBasicMaterial( {color: "#989898"} );
		var cam = new THREE.Mesh( geometry_cam, material_cam );
		cam.position.x=start_x+ dimension/2;
		cam.position.z=start_z + dimension;
		cam.position.y=50/5;
		scene.add( cam );

		var geometry = new THREE.SphereGeometry( 3, 32, 32 );
		var material = new THREE.MeshBasicMaterial( {color: "#000000"} );
		var sphere = new THREE.Mesh( geometry, material );
		sphere.position.x=start_x+ dimension/2;
		sphere.position.z=start_z + dimension;
		sphere.position.y=50/2 - 2;
		scene.add( sphere );

		
		this.cam_p_x=start_x+ dimension/2;
		this.cam_p_z=start_z + dimension;
		this.cam_p_y=50/2 - 2;


		var geometry_local_c = new THREE.CylinderGeometry( 5, 5, 4, 32 );
		var material__local_c  = new THREE.MeshBasicMaterial( {color: "#5e5e5e"} );
		var local_c = new THREE.Mesh( geometry_local_c, material__local_c );
		local_c.position.x=start_x+ dimension + 100;
		local_c.position.z=start_z + dimension;
		local_c.position.y=2;
		scene.add( local_c );


		this.local_c_x=start_x+ dimension + 100;;
  		this.local_c_y=2;
  		this.local_c_z=start_z + dimension;
		

		var material = new THREE.LineBasicMaterial({
			color: 0x0000ff
		});

		var geometry = new THREE.Geometry();
		geometry.vertices.push(
			new THREE.Vector3( start_x+ dimension/2, 0,start_z + dimension ),
			new THREE.Vector3( start_x+ dimension + 100, 0, start_z + dimension )
			
		);

		var line = new THREE.Line( geometry, material );
		scene.add( line );

   }

}

   