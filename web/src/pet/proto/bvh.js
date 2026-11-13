// The fitting rays (the face, the rim, the tops, the feet) go through a BVH. three's own Mesh.raycast tests every
// triangle of the body for each ray, and a pet's thousands of rays held the main thread for about half a second a pet.
// The hits are the same: the BVH calls the same Ray.intersectTriangle with the same backface rule. `indirect` leaves the
// geometry's index untouched, and the tree is rebuilt when the positions or the index changed since it was built.
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

const trees = new WeakMap();

function treeOf(geometry) {
  const version = geometry.attributes.position.version;
  const held = trees.get(geometry);
  if (held && held.version === version && held.index === geometry.index) return held.tree;
  const tree = new MeshBVH(geometry, { indirect: true });
  trees.set(geometry, { version, index: geometry.index, tree });
  return tree;
}

function raycast(raycaster, intersects) {
  this.geometry.boundsTree = treeOf(this.geometry);
  acceleratedRaycast.call(this, raycaster, intersects);
}

/** The mesh, raycast through its geometry's BVH. */
export function accelerated(mesh) {
  mesh.raycast = raycast;
  return mesh;
}
