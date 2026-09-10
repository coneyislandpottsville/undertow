import * as THREE from "three";
import type { LabParams, LabScene } from "../harness";
import { createGlRenderer } from "../gl-renderer";
import { addLights, applyRideFov, disposeAll } from "./shared-gl";

export async function createScene(canvas: HTMLCanvasElement, params: LabParams): Promise<LabScene> {
  const gr = createGlRenderer(canvas, params);
  const { renderer } = gr;
  const theme = params.theme;
  const R = 16;
  const N = Math.min(1_000_000, Math.max(1000, Math.floor(params.num("n", 50000))));
  const M = Math.max(0, Math.floor(params.num("mist", 48)));
  const soft = params.num("soft", 0.35);
  const size = params.num("size", 0.045);
  const alpha = params.num("alpha", 0.3);
  const maxLife = 1.8;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(theme.fog, 0.012);
  scene.background = new THREE.Color(theme.fog);
  const camera = new THREE.PerspectiveCamera(80, 1, 0.08, 260);
  scene.add(camera);
  const { rider } = addLights(scene, camera, theme);

  const wallMat = new THREE.MeshStandardMaterial({
    color: theme.wall,
    roughness: 0.72,
    metalness: 0.04,
    side: THREE.DoubleSide,
  });
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 8, 96, 1, true), wallMat);
  wall.position.y = 0.5;
  scene.add(wall);
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(R - 0.05, 64),
    new THREE.MeshStandardMaterial({
      color: theme.water,
      roughness: 0.15,
      metalness: 0.2,
      emissive: new THREE.Color(theme.water),
      emissiveIntensity: 0.25,
    }),
  );
  water.rotation.x = -Math.PI / 2;
  scene.add(water);
  const lip = new THREE.Mesh(
    new THREE.TorusGeometry(R, 0.38, 8, 96),
    new THREE.MeshStandardMaterial({ color: theme.ring, roughness: 0.35, metalness: 0.15 }),
  );
  lip.rotation.x = Math.PI / 2;
  scene.add(lip);
  const buoy = new THREE.Mesh(
    new THREE.TorusGeometry(0.5, 0.12, 10, 28),
    new THREE.MeshStandardMaterial({ color: 0x1c2c32, roughness: 0.7 }),
  );
  buoy.rotation.x = Math.PI / 2;
  buoy.position.y = 0.08;
  scene.add(buoy);

  const pos = new Float32Array(N * 3);
  const vel = new Float32Array(N * 3);
  const life = new Float32Array(N);
  let seed = 9;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < N; i++) {
    life[i] = -rand() * maxLife;
    pos[i * 3 + 1] = -100;
  }
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  const lifeAttr = new THREE.BufferAttribute(life, 1);
  lifeAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", posAttr);
  geo.setAttribute("life", lifeAttr);

  const depthTexture = new THREE.DepthTexture(2, 2);
  depthTexture.type = THREE.UnsignedIntType;
  const depthRT = new THREE.WebGLRenderTarget(2, 2, { depthTexture, depthBuffer: true });

  const uniforms = {
    uSize: { value: size },
    uScale: { value: 1 },
    uRider: { value: new THREE.Vector3() },
    uDepth: { value: depthTexture },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uNear: { value: camera.near },
    uFar: { value: camera.far },
    uSoft: { value: soft },
    uColor: { value: new THREE.Color(0xdff4f8) },
    uAlpha: { value: alpha },
    uMaxLife: { value: maxLife },
  };
  const makeMaterial = () =>
    new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(uniforms),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute float life;
        uniform float uSize;
        uniform float uScale;
        uniform vec3 uRider;
        uniform float uMaxLife;
        varying float vLight;
        varying float vRemain;
        varying float vViewZ;
        void main() {
          vRemain = clamp( life, 0.0, uMaxLife ) / uMaxLife;
          vec4 mv = modelViewMatrix * vec4( position, 1.0 );
          vViewZ = -mv.z;
          gl_Position = projectionMatrix * mv;
          float d = distance( position, uRider );
          vLight = ( 1.35 * 9.0 ) / ( d * d + 1.0 ) + 0.2;
          gl_PointSize = uSize * ( 0.6 + 0.6 * vRemain ) * uScale / max( vViewZ, 0.05 );
        }`,
      fragmentShader: `
        #include <packing>
        uniform sampler2D uDepth;
        uniform vec2 uResolution;
        uniform float uNear;
        uniform float uFar;
        uniform float uSoft;
        uniform vec3 uColor;
        uniform float uAlpha;
        varying float vLight;
        varying float vRemain;
        varying float vViewZ;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float radial = smoothstep( 0.5, 0.05, length( c ) );
          float sceneDepth = texture2D( uDepth, gl_FragCoord.xy / uResolution ).r;
          float sceneZ = -perspectiveDepthToViewZ( sceneDepth, uNear, uFar );
          float soft = clamp( ( sceneZ - vViewZ ) / uSoft, 0.0, 1.0 );
          float fade = smoothstep( 0.0, 0.35, vRemain );
          gl_FragColor = vec4( uColor * vLight, radial * fade * soft * uAlpha );
        }`,
    });
  const sprayMat = makeMaterial();
  const points = new THREE.Points(geo, sprayMat);
  points.frustumCulled = false;
  scene.add(points);

  let mist: THREE.Points | null = null;
  const mistMat = makeMaterial();
  if (M > 0) {
    const mpos = new Float32Array(M * 3);
    const mlife = new Float32Array(M).fill(maxLife);
    for (let i = 0; i < M; i++) {
      const a = rand() * Math.PI * 2;
      const r = 0.4 + rand() * 2.4;
      mpos[i * 3] = Math.cos(a) * r;
      mpos[i * 3 + 1] = 0.3 + rand() * 1.6;
      mpos[i * 3 + 2] = Math.sin(a) * r;
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute("position", new THREE.BufferAttribute(mpos, 3));
    mg.setAttribute("life", new THREE.BufferAttribute(mlife, 1));
    mistMat.uniforms.uSize!.value = 3.2;
    mistMat.uniforms.uSoft!.value = 2.0;
    mistMat.uniforms.uAlpha!.value = 0.035;
    mistMat.uniforms.uColor!.value = new THREE.Color(theme.ring);
    mist = new THREE.Points(mg, mistMat);
    mist.frustumCulled = false;
    scene.add(mist);
  }

  const riderWorld = new THREE.Vector3();
  let frame = 0;

  const step = (dt: number) => {
    frame++;
    for (let i = 0; i < N; i++) {
      let l = life[i]! - dt;
      const j = i * 3;
      if (l < 0) {
        const r1 = rand();
        const r2 = rand();
        const r3 = rand();
        const ang = r1 * Math.PI * 2;
        const spread = r2 * 0.85;
        const speed = r3 * 5 + 3;
        vel[j] = Math.cos(ang) * Math.sin(spread) * speed;
        vel[j + 1] = Math.cos(spread) * speed;
        vel[j + 2] = Math.sin(ang) * Math.sin(spread) * speed;
        pos[j] = (r2 - 0.5) * 0.3;
        pos[j + 1] = 0.05;
        pos[j + 2] = (r3 - 0.5) * 0.3;
        l = r2 * 1.2 + 0.6;
      } else {
        vel[j + 1]! -= dt * 9.8;
        const drag = 1 - dt * 0.6;
        vel[j]! *= drag;
        vel[j + 1]! *= drag;
        vel[j + 2]! *= drag;
        pos[j]! += vel[j]! * dt;
        pos[j + 1]! += vel[j + 1]! * dt;
        pos[j + 2]! += vel[j + 2]! * dt;
        if (pos[j + 1]! < 0) l = -0.01;
      }
      life[i] = l;
    }
    posAttr.needsUpdate = true;
    lifeAttr.needsUpdate = true;
  };

  return {
    backend: gr.backend,
    frame(dt, t) {
      step(Math.min(dt, 1 / 30));
      const orbit = t * 0.15;
      camera.position.set(Math.cos(orbit) * 5.5, 1.3, Math.sin(orbit) * 5.5);
      camera.lookAt(0, 0.8, 0);
      camera.updateMatrixWorld();
      rider.getWorldPosition(riderWorld);
      sprayMat.uniforms.uRider!.value.copy(riderWorld);
      mistMat.uniforms.uRider!.value.copy(riderWorld);
      gr.timed(() => {
        points.visible = false;
        if (mist) mist.visible = false;
        renderer.setRenderTarget(depthRT);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        points.visible = true;
        if (mist) mist.visible = true;
        renderer.render(scene, camera);
      });
    },
    resize(w, h) {
      renderer.setSize(w, h, false);
      applyRideFov(camera, w, h);
      depthRT.setSize(w, h);
      for (const m of [sprayMat, mistMat]) {
        m.uniforms.uResolution!.value.set(w, h);
        m.uniforms.uScale!.value = h / (2 * Math.tan((camera.fov * Math.PI) / 360));
      }
    },
    gpuMs: gr.gpuMs,
    info: () => ({ ...gr.info(), extra: { particles: N, mist: M, soft, frame } }),
    dispose() {
      disposeAll(scene);
      depthRT.dispose();
      gr.dispose();
    },
  };
}
