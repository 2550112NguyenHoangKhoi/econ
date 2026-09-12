import { Evaluator, Brush, SUBTRACTION } from 'three-bvh-csg';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Constructive solid geometry, and the cache that keeps it affordable.
//
// Window openings are real subtractions from the wall solid rather than painted-on
// rectangles, which is what makes a wall read as a wall from inside the model. CSG is
// expensive, so every result is cached by a signature of its inputs.

// ========== CSG Helper (three-bvh-csg Evaluator/Brush API) ==========
// three-bvh-csg has no static `CSG` helper; it exposes an Evaluator that
// operates on Brush meshes whose world matrices define their placement.
const csgEvaluator = new Evaluator();
csgEvaluator.attributes = ['position', 'normal'];

function meshToBrush(mesh) {
  mesh.updateMatrix();
  const brush = new Brush(mesh.geometry);
  brush.position.copy(mesh.position);
  brush.quaternion.copy(mesh.quaternion);
  brush.scale.copy(mesh.scale);
  brush.updateMatrixWorld(true);
  return brush;
}

// Subtract one or more tool meshes from a base mesh; returns baked geometry
// in the base mesh's transformed (world) space, matching the old CSG.toMesh.
function csgSubtract(baseMesh, toolMeshes) {
  if (!toolMeshes || toolMeshes.length === 0) {
    baseMesh.updateMatrix();
    return baseMesh.geometry.clone().applyMatrix4(baseMesh.matrix);
  }
  let result = meshToBrush(baseMesh);
  toolMeshes.forEach((tool) => {
    result = csgEvaluator.evaluate(result, meshToBrush(tool), SUBTRACTION);
  });
  let resultGeom = result.geometry;
  resultGeom = BufferGeometryUtils.mergeVertices(resultGeom, 1e-4);
  resultGeom.computeVertexNormals();
  return resultGeom;
}

// ========== Module-level CSG geometry cache ==========
// CSG is expensive and the tower has only ~5 distinct floor shapes across its
// 14 levels (the 8 typical-office floors are identical). Keying the result on a
// structural signature means each unique wall/plate runs CSG exactly once and
// the geometry is shared by every floor that matches — cutting initial CSG cost
// by ~3x. Geometries live for the app lifetime (bounded set), so no disposal is
// needed; the cache itself prevents the unbounded-leak case.
const _geometryCache = new Map();
function getCachedGeometry(signature, build) {
  let geom = _geometryCache.get(signature);
  if (!geom) {
    geom = build();
    _geometryCache.set(signature, geom);
  }
  return geom;
}

export { csgEvaluator, meshToBrush, csgSubtract, getCachedGeometry };
