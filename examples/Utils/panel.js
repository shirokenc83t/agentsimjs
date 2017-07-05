function solar_panel(id,dimension,position_x,position_z){

   this.id=id;
   this.start_x=position_x;
   this.start_y=(dimension/2);
   this.start_z=position_z;
   this.dimension=dimension;

 


		  this.spawn=function(){


		  		var geometry = new THREE.BoxGeometry( this.dimension, dimension, 1 );
				var material = new THREE.MeshBasicMaterial( {color: "#02529c"} );
				var panel = new THREE.Mesh( geometry, material );
				panel.position.x=this.start_x;
				panel.position.z=this.start_z;
				panel.position.y=this.start_y;
				panel.rotation.x=-Math.PI/4;
				scene.add( panel );


				var geometry_support = new THREE.BoxGeometry( dimension/10, dimension/2,  dimension/10);
				var material_support = new THREE.MeshBasicMaterial( {color: "#989898"} );
				var support = new THREE.Mesh( geometry_support, material_support );
				support.position.x=this.start_x;
				support.position.z=this.start_z;
				support.position.y=dimension/5;
				scene.add( support );



			    var gridHelper = new THREE.GridHelper(  this.dimension/2,  this.dimension/10 );

			    gridHelper.position.x=this.start_x;
				gridHelper.position.z=this.start_z+1;
				gridHelper.position.y=this.start_y;
				gridHelper.rotation.x=Math.PI/4;

			    scene.add( gridHelper );



		  };


};
 
