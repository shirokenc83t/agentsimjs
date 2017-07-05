function onDocumentMouseDown( event ) {

				event.preventDefault();

				mouse.x = ( event.clientX / renderer.domElement.clientWidth ) * 2 - 1;
				mouse.y = - ( event.clientY / renderer.domElement.clientHeight ) * 2 + 1;

				raycaster.setFromCamera( mouse, camera );

				var intersects = raycaster.intersectObjects( objects );

				if ( intersects.length > 0 ) {

					var intersect = intersects[ 0 ];

					if ( isShiftDown ) {

						if ( intersect.object != plane ) {

							/*scene.remove( intersect.object );

							objects.splice( objects.indexOf( intersect.object ), 1 );*/
							//alert(intersect.object.name);
							var object = scene.getObjectByName( "webservice1" );
							scene.remove( object );

						}

					} else {

						/*var voxel = new THREE.Mesh( cubeGeometry, cubeMaterial );
						voxel.position.copy( intersect.point ).add( intersect.face.normal );
						voxel.position.divideScalar( 50 ).floor().multiplyScalar( 50 ).addScalar( 25 );
						scene.add( voxel );

						objects.push( voxel );*/
						//alert(intersect.object.name);
						addSingleClusterBus(intersect.object);
					}

					render();

				}

			}

			function onDocumentKeyDown( event ) {

				switch( event.keyCode ) {

					case 16: isShiftDown = true; break;

				}

			}

			function onDocumentKeyUp( event ) {

				switch( event.keyCode ) {

					case 16: isShiftDown = false; break;

				}
			}
