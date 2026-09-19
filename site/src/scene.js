// three.js view of the measured flight and the forecasts.
// Data frame: position NED [m], attitude ZYX Euler of the FRD body.
// three.js frame: x = East, y = Up, z = -North.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";

const WINGSPAN_M = 0.617;
const DISPLAY_SCALE = 2; // the 63 g aircraft is drawn larger than life so it reads in a 40 m hall
const PAST_TRAIL_SAMPLES = 480;
const HINGE_Y = new THREE.Vector3(0, 1, 0);
const SPIN_Z = new THREE.Vector3(0, 0, 1);
const HINGE_X = new THREE.Vector3(1, 0, 0);

export const nedToThree = (p) => new THREE.Vector3(p[1], -p[2], -p[0]);

// Mesh frame (x forward, y up, z right) -> FRD body -> NED world -> three.js world.
const NED_TO_THREE = new THREE.Matrix4().set(0, 1, 0, 0, 0, 0, -1, 0, -1, 0, 0, 0, 0, 0, 0, 1);
const MESH_TO_BODY = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
export function attitudeToThree(phi, theta, psi) {
  const [cp, sp, ct, st, cs, ss] = [Math.cos(phi), Math.sin(phi), Math.cos(theta), Math.sin(theta), Math.cos(psi), Math.sin(psi)];
  const bodyToNed = new THREE.Matrix4().set(
    ct * cs, sp * st * cs - cp * ss, cp * st * cs + sp * ss, 0,
    ct * ss, sp * st * ss + cp * cs, cp * st * ss - sp * cs, 0,
    -st, sp * ct, cp * ct, 0,
    0, 0, 0, 1);
  return new THREE.Quaternion().setFromRotationMatrix(NED_TO_THREE.clone().multiply(bodyToNed).multiply(MESH_TO_BODY));
}

function findNamedPart(root, name) {
  let found = null;
  root.traverse((node) => { if (!found && node.name === name) found = node; });
  return found;
}

// --- Sport Cub asset, lifted from the rumoca_fixed_wing workbench -----------------
// The asset needs three repairs before it can be posed; see the comments inline.
function prepareAircraftTemplate(scene) {
  // The asset's Right* meshes contain an unremoved duplicate of the left side's
  // geometry; strip the wrong-side triangles so the duplicate never renders.
  for (const name of ["RightAileron", "RightFlap", "RightWheel"]) {
    const node = findNamedPart(scene, name);
    let mesh = null;
    if (node) node.traverse((child) => { if (!mesh && child.isMesh) mesh = child; });
    if (!mesh) continue;
    const source = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
    const pos = source.getAttribute("position");
    const materialIndexOf = (tri) => {
      for (const group of source.groups) {
        if (tri >= group.start && tri < group.start + group.count) return group.materialIndex || 0;
      }
      return 0;
    };
    const kept = [];
    for (let tri = 0; tri < pos.count; tri += 3) {
      if ((pos.getX(tri) + pos.getX(tri + 1) + pos.getX(tri + 2)) / 3 < 0) kept.push(tri);
    }
    const cleaned = new THREE.BufferGeometry();
    for (const [attrName, attr] of Object.entries(source.attributes)) {
      const out = new Float32Array(kept.length * 3 * attr.itemSize);
      let w = 0;
      // getComponent handles interleaved and normalized attributes (raw indexing corrupts UVs).
      for (const tri of kept) for (let v = 0; v < 3; v += 1) for (let c = 0; c < attr.itemSize; c += 1) out[w++] = attr.getComponent(tri + v, c);
      cleaned.setAttribute(attrName, new THREE.BufferAttribute(out, attr.itemSize, attr.normalized));
    }
    // Multi-material meshes address their materials through geometry groups.
    if (source.groups && source.groups.length) {
      let runStart = 0;
      let runMaterial = kept.length ? materialIndexOf(kept[0]) : 0;
      kept.forEach((tri, idx) => {
        const m = materialIndexOf(tri);
        if (m !== runMaterial) {
          cleaned.addGroup(runStart * 3, (idx - runStart) * 3, runMaterial);
          runStart = idx;
          runMaterial = m;
        }
      });
      if (kept.length) cleaned.addGroup(runStart * 3, (kept.length - runStart) * 3, runMaterial);
    }
    mesh.geometry = cleaned;
  }
  // Pivots are authored as siblings of the surfaces; re-parent each mesh under its
  // pivot (preserving world transforms) so rotating the pivot articulates it.
  for (const name of ["Elevator", "Rudder", "LeftAileron", "RightAileron", "LeftFlap", "RightFlap", "Prop", "LeftWheel", "RightWheel", "NoseWheel"]) {
    const mesh = findNamedPart(scene, name);
    const pivot = findNamedPart(scene, `${name}Pivot`);
    if (mesh && pivot) pivot.attach(mesh);
  }
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  scene.position.sub(box.getCenter(new THREE.Vector3()));
  const wrapper = new THREE.Group();
  wrapper.add(scene);
  wrapper.rotation.y = Math.PI / 2; // glTF faces +Z; the mesh frame here is x-forward
  wrapper.scale.setScalar((WINGSPAN_M * DISPLAY_SCALE) / Math.max(size.x, size.z, 1e-6));
  return wrapper;
}

function articulate(clone) {
  const parts = {
    leftAileron: findNamedPart(clone, "LeftAileronPivot"), rightAileron: findNamedPart(clone, "RightAileronPivot"),
    elevator: findNamedPart(clone, "ElevatorPivot"), rudder: findNamedPart(clone, "RudderPivot"), prop: findNamedPart(clone, "PropPivot"),
  };
  for (const part of Object.values(parts)) if (part) part.userData.baseQuat = part.quaternion.clone();
  // The authored aileron pivot axes are misaligned with the hinge lines of the
  // tapered wing; fit each hinge through the surface's vertices nearest the pivot.
  let referenceWorldAxis = null;
  for (const key of ["leftAileron", "rightAileron"]) {
    const pivot = parts[key];
    let mesh = null;
    pivot?.traverse((node) => { if (!mesh && node.isMesh) mesh = node; });
    if (!mesh) continue;
    mesh.updateMatrix();
    const posAttr = mesh.geometry.getAttribute("position");
    const pts = [];
    for (let i = 0; i < posAttr.count; i += 1) pts.push(new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(mesh.matrix));
    const bb = new THREE.Box3().setFromPoints(pts);
    const ext = bb.getSize(new THREE.Vector3());
    const spanDim = ext.x >= ext.y && ext.x >= ext.z ? "x" : ext.y >= ext.z ? "y" : "z";
    const others = ["x", "y", "z"].filter((d) => d !== spanDim);
    const bins = 8;
    const step = Math.max(ext[spanDim] / bins, 1e-9);
    const best = new Array(bins).fill(null);
    for (const point of pts) {
      const bin = Math.min(bins - 1, Math.max(0, Math.floor((point[spanDim] - bb.min[spanDim]) / step)));
      const cross = point[others[0]] ** 2 + point[others[1]] ** 2;
      if (!best[bin] || cross < best[bin].cross) best[bin] = { point, cross };
    }
    const edge = best.filter(Boolean).map((b) => b.point);
    const axis = edge.length >= 2 ? edge[edge.length - 1].clone().sub(edge[0]).normalize()
      : new THREE.Vector3(spanDim === "x" ? 1 : 0, spanDim === "y" ? 1 : 0, spanDim === "z" ? 1 : 0);
    // Mirror the sign convention across the wings via a shared world spanwise direction.
    const worldAxis = axis.clone().applyQuaternion(pivot.getWorldQuaternion(new THREE.Quaternion()));
    if (referenceWorldAxis === null) {
      if (axis.dot(SPIN_Z) < 0) { axis.negate(); worldAxis.negate(); }
      referenceWorldAxis = worldAxis;
    } else if (worldAxis.dot(referenceWorldAxis) < 0) {
      axis.negate();
    }
    pivot.userData.hingeAxis = axis;
  }
  return parts;
}

function setHinge(part, axis, angle) {
  if (!part?.userData.baseQuat) return;
  part.quaternion.copy(part.userData.baseQuat).multiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
}
// ---------------------------------------------------------------------------------

const cssColor = (name) => new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888888");

export function createScene(host, methodColors) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch (error) {
    host.textContent = "The 3D view needs WebGL, which this browser did not provide.";
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 400);
  camera.position.set(19, 8, 12);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(9, 2.5, 2);
  controls.minDistance = 2;
  controls.maxDistance = 80;
  controls.maxPolarAngle = Math.PI / 2 - 0.02;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7280, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.3);
  sun.position.set(6, 12, 8);
  scene.add(sun);
  let grid = null;

  const aircraft = new THREE.Group();
  scene.add(aircraft);
  let parts = {};
  new GLTFLoader().load("./public/assets/airplane.glb", (gltf) => {
    const model = prepareAircraftTemplate(gltf.scene);
    aircraft.add(model);
    parts = articulate(model);
  }, undefined, () => {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.7, 12), new THREE.MeshStandardMaterial({ color: 0x9aa4b2 }));
    cone.rotation.z = -Math.PI / 2;
    aircraft.add(cone);
  });

  // Measured trail: screen-space-thick line segments, so tracking gaps stay gaps.
  const materials = [];
  const lineMaterial = (linewidth) => {
    const material = new LineMaterial({ linewidth, worldUnits: false });
    materials.push(material);
    return material;
  };
  const trailMaterial = lineMaterial(3);
  let trail = null;

  const forecasts = new Map(); // method -> { line, marker, states }
  let forecastStart = 0;
  let flight = null;
  let cameraMode = "observer";
  let trailKey = "";
  let spin = 0;

  function applyTheme() {
    renderer.setClearColor(cssColor("--scene-bg"));
    trailMaterial.color.copy(cssColor("--text-primary"));
    if (grid) scene.remove(grid);
    grid = new THREE.GridHelper(60, 30, cssColor("--axis"), cssColor("--grid"));
    grid.position.set(9, 0, 2);
    scene.add(grid);
    forecasts.forEach((entry, method) => {
      entry.line.material.color.copy(cssColor(methodColors[method]));
      entry.marker.material.color.copy(cssColor(methodColors[method]));
    });
  }
  applyTheme();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

  function resize() {
    const width = host.clientWidth || 800;
    const height = host.clientHeight || 420;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    materials.forEach((material) => material.resolution.set(width, height));
  }
  new ResizeObserver(resize).observe(host);
  resize();

  function clearForecasts() {
    forecasts.forEach((entry) => {
      scene.remove(entry.line, entry.marker);
      entry.line.geometry.dispose();
    });
    forecasts.clear();
    trailKey = "";
  }

  function setForecast(method, states, startIndex) {
    const existing = forecasts.get(method);
    if (existing) {
      scene.remove(existing.line, existing.marker);
      existing.line.geometry.dispose();
    }
    forecastStart = startIndex;
    const geometry = new LineGeometry().setPositions(states.flatMap((state) => [state[1], -state[2], -state[0]]));
    const color = cssColor(methodColors[method]);
    const material = lineMaterial(2.5);
    material.color.copy(color);
    material.resolution.set(host.clientWidth || 800, host.clientHeight || 420);
    const line = new Line2(geometry, material);
    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), new THREE.MeshBasicMaterial({ color }));
    scene.add(line, marker);
    forecasts.set(method, { line, marker, states });
  }

  // `position` is a fractional sample index into the flight.
  function setTime(position, deltaS = 0) {
    if (!flight) return;
    const index = Math.floor(position);
    const state = flight.state(index);
    if (Number.isFinite(state[0])) {
      aircraft.visible = true;
      aircraft.position.copy(nedToThree(state));
      aircraft.quaternion.copy(attitudeToThree(state[6], state[7], state[8]));
      const [roll, pitch, throttle, yaw] = flight.command(index);
      // Sticks, not surfaces: the receiver's own deflections are never measured.
      setHinge(parts.leftAileron, parts.leftAileron?.userData.hingeAxis || SPIN_Z, -1.0 * roll);
      setHinge(parts.rightAileron, parts.rightAileron?.userData.hingeAxis || SPIN_Z, 1.0 * roll);
      setHinge(parts.elevator, SPIN_Z, 1.0 * pitch);
      setHinge(parts.rudder, HINGE_Y, -1.0 * yaw);
      spin += deltaS * (22 + 90 * Math.max(0, throttle));
      setHinge(parts.prop, HINGE_X, spin);
    } else {
      aircraft.visible = false;
    }

    // The trail runs to the end of the forecast window while one is shown, so the
    // measured path can be compared with the predictions ahead of the aircraft.
    const forecastEnd = Math.max(0, ...[...forecasts.values()].map((entry) => forecastStart + entry.states.length - 1));
    const last = Math.max(index, Math.min(forecastEnd, flight.samples - 1));
    const key = `${Math.max(1, index - PAST_TRAIL_SAMPLES + 1)}:${last}`;
    if (key !== trailKey) {
      trailKey = key;
      const segments = [];
      for (let i = Math.max(1, index - PAST_TRAIL_SAMPLES + 1); i <= last; i += 1) {
        const a = flight.state(i - 1);
        const b = flight.state(i);
        if (Number.isFinite(a[0]) && Number.isFinite(b[0])) segments.push(a[1], -a[2], -a[0], b[1], -b[2], -b[0]);
      }
      if (trail) { scene.remove(trail); trail.geometry.dispose(); trail = null; }
      if (segments.length) {
        trail = new LineSegments2(new LineSegmentsGeometry().setPositions(segments), trailMaterial);
        scene.add(trail);
      }
    }

    forecasts.forEach((entry) => {
      const k = Math.min(entry.states.length - 1, Math.max(0, index - forecastStart));
      entry.marker.visible = index >= forecastStart && index - forecastStart < entry.states.length;
      entry.marker.position.copy(nedToThree(entry.states[k]));
    });

    if (aircraft.visible && cameraMode === "observer") {
      // Keep the orbit centred on the aircraft without fighting the user's drag.
      const shift = aircraft.position.clone().sub(controls.target).multiplyScalar(0.08);
      controls.target.add(shift);
      camera.position.add(shift);
    } else if (aircraft.visible) {
      const heading = state[8];
      const forward = new THREE.Vector3(Math.sin(heading), 0, -Math.cos(heading));
      const desired = cameraMode === "chase"
        ? aircraft.position.clone().addScaledVector(forward, -4.5).add(new THREE.Vector3(0, 1.4, 0))
        : aircraft.position.clone().add(new THREE.Vector3(0, 30, 0.01));
      camera.position.lerp(desired, 0.15);
      controls.target.lerp(aircraft.position, 0.25);
    }
  }

  function frame() {
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    setFlight(next) { flight = next; trailKey = ""; clearForecasts(); },
    setTime,
    setForecast,
    clearForecasts,
    setCamera(mode) {
      cameraMode = mode;
      controls.enabled = mode === "observer";
      if (mode === "observer") camera.position.copy(controls.target).add(new THREE.Vector3(10, 5.5, 10));
    },
  };
}
