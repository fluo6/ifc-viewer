import * as THREE from "three";

export type GumballHandle =
  | "translate-x" | "translate-y" | "translate-z"
  | "plane-xy" | "plane-yz" | "plane-xz"
  | "rotate-x" | "rotate-y" | "rotate-z"
  | "scale-x" | "scale-y" | "scale-z";

export interface GumballTransform {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

export interface ClippingGumballOptions {
  camera: THREE.Camera;
  domElement: HTMLElement;
  scene: THREE.Scene;
  onStart: (handle: GumballHandle, snapshot: GumballTransform) => void;
  onChange: (transform: GumballTransform, handle: GumballHandle, snapped: boolean) => void;
  onEnd: () => void;
  onCancel: (snapshot: GumballTransform) => void;
}

export class ClippingGumball {
  readonly object = new THREE.Group();
  private options: ClippingGumballOptions;
  
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  
  private handles: THREE.Mesh[] = [];
  
  private activeHandle: GumballHandle | null = null;
  private pointerId: number | null = null;
  
  private snapshot: GumballTransform | null = null;
  private startPointer = new THREE.Vector2();
  private startRay = new THREE.Ray();
  private dragPlane = new THREE.Plane();
  private dragIntersection = new THREE.Vector3();
  private startIntersection = new THREE.Vector3();
  
  private materials: THREE.Material[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private attached = false;

  constructor(options: ClippingGumballOptions) {
    this.options = options;
    this.object.name = "ClippingGumball";
    this.object.visible = false;
    this.buildHandles();
    this.bindEvents();
  }
  
  private buildHandles() {
    const createMat = (c: number) => {
      const mat = new THREE.MeshBasicMaterial({ color: c, depthTest: false, depthWrite: false, transparent: true, opacity: 0.8, side: THREE.DoubleSide });
      this.materials.push(mat);
      return mat;
    };
    
    const matX = createMat(0xff0000);
    const matY = createMat(0x00ff00);
    const matZ = createMat(0x0000ff);
    
    const arrowGeo = new THREE.ConeGeometry(0.05, 0.2, 8);
    arrowGeo.translate(0, 0.9, 0);
    const lineGeo = new THREE.CylinderGeometry(0.01, 0.01, 0.8);
    lineGeo.translate(0, 0.4, 0);
    
    const planeGeo = new THREE.PlaneGeometry(0.3, 0.3);
    planeGeo.translate(0.3, 0.3, 0);
    
    const arcGeo = new THREE.TorusGeometry(0.6, 0.015, 4, 32, Math.PI);
    
    const scaleGeo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    scaleGeo.translate(0, 0.6, 0);
    
    this.geometries.push(arrowGeo, lineGeo, planeGeo, arcGeo, scaleGeo);
    
    const addHandle = (geo: THREE.BufferGeometry, mat: THREE.Material, name: GumballHandle, xRot: number, yRot: number, zRot: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.userData = { handle: name };
      m.rotation.set(xRot, yRot, zRot);
      this.handles.push(m);
      this.object.add(m);
    };

    // Translate
    addHandle(arrowGeo, matX, 'translate-x', 0, 0, -Math.PI/2);
    addHandle(lineGeo, matX, 'translate-x', 0, 0, -Math.PI/2);
    addHandle(arrowGeo, matY, 'translate-y', 0, 0, 0);
    addHandle(lineGeo, matY, 'translate-y', 0, 0, 0);
    addHandle(arrowGeo, matZ, 'translate-z', Math.PI/2, 0, 0);
    addHandle(lineGeo, matZ, 'translate-z', Math.PI/2, 0, 0);

    // Plane
    addHandle(planeGeo, matZ, 'plane-xy', 0, 0, 0); // blue
    addHandle(planeGeo, matX, 'plane-yz', 0, Math.PI/2, 0); // red
    addHandle(planeGeo, matY, 'plane-xz', Math.PI/2, 0, 0); // green
    
    // Rotate
    addHandle(arcGeo, matX, 'rotate-x', 0, Math.PI/2, 0);
    addHandle(arcGeo, matY, 'rotate-y', Math.PI/2, 0, 0);
    addHandle(arcGeo, matZ, 'rotate-z', 0, 0, 0);
    
    // Scale
    addHandle(scaleGeo, matX, 'scale-x', 0, 0, -Math.PI/2);
    addHandle(scaleGeo, matY, 'scale-y', 0, 0, 0);
    addHandle(scaleGeo, matZ, 'scale-z', Math.PI/2, 0, 0);
  }

  private bindEvents() {
    this.options.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.options.domElement.addEventListener('pointermove', this.onPointerMove);
    this.options.domElement.addEventListener('pointerup', this.onPointerUp);
    this.options.domElement.addEventListener('pointercancel', this.onPointerCancel);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('blur', this.onBlur);
  }

  private unbindEvents() {
    this.options.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.options.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.options.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.options.domElement.removeEventListener('pointercancel', this.onPointerCancel);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('blur', this.onBlur);
  }

  private onPointerDown = (e: PointerEvent) => {
    if (!this.object.visible || this.activeHandle) return;
    this.updatePointer(e);
    this.raycaster.setFromCamera(this.pointer, this.options.camera);
    const hits = this.raycaster.intersectObjects(this.handles, true);
    if (hits.length > 0 && hits[0]) {
      e.stopPropagation();
      this.activeHandle = hits[0].object.userData.handle as GumballHandle;
      this.pointerId = e.pointerId;
      try { this.options.domElement.setPointerCapture(e.pointerId); } catch {}
      
      this.snapshot = {
        position: this.object.position.clone(),
        quaternion: this.object.quaternion.clone(),
        scale: this.object.scale.clone()
      };
      
      this.startPointer.copy(this.pointer);
      this.startRay.copy(this.raycaster.ray);
      
      const camFwd = new THREE.Vector3();
      this.options.camera.getWorldDirection(camFwd);
      
      if (this.activeHandle.startsWith('rotate')) {
        let axis = new THREE.Vector3();
        if (this.activeHandle === 'rotate-x') axis.set(1, 0, 0);
        else if (this.activeHandle === 'rotate-y') axis.set(0, 1, 0);
        else axis.set(0, 0, 1);
        axis.applyQuaternion(this.snapshot.quaternion).normalize();
        this.dragPlane.setFromNormalAndCoplanarPoint(axis, this.object.position);
      } else if (this.activeHandle.startsWith('plane')) {
        let axis = new THREE.Vector3();
        if (this.activeHandle === 'plane-xy') axis.set(0, 0, 1);
        else if (this.activeHandle === 'plane-yz') axis.set(1, 0, 0);
        else axis.set(0, 1, 0);
        axis.applyQuaternion(this.snapshot.quaternion).normalize();
        this.dragPlane.setFromNormalAndCoplanarPoint(axis, this.object.position);
      } else {
        this.dragPlane.setFromNormalAndCoplanarPoint(camFwd, this.object.position);
      }
      
      this.startRay.intersectPlane(this.dragPlane, this.startIntersection);
      
      this.options.onStart(this.activeHandle, this.snapshot);
    }
  };

  private getModelDiagonal(): number {
    const v = (window as any).__viewer;
    if (v) {
       const box = v.getModelBoundingBox();
       if (box) return box.getSize(new THREE.Vector3()).length();
    }
    return 100;
  }

  private onPointerMove = (e: PointerEvent) => {
    if (!this.activeHandle || !this.snapshot) return;
    e.stopPropagation();
    this.updatePointer(e);
    this.raycaster.setFromCamera(this.pointer, this.options.camera);
    
    if (this.raycaster.ray.intersectPlane(this.dragPlane, this.dragIntersection)) {
      const delta = new THREE.Vector3().subVectors(this.dragIntersection, this.startIntersection);
      
      let snapped = false;
      let snapDisp = e.shiftKey ? this.getModelDiagonal() / 200 : 0;
      let snapRot = e.shiftKey ? Math.PI / 36 : 0;
      
      const newPos = this.snapshot.position.clone();
      const newQuat = this.snapshot.quaternion.clone();
      const newScale = this.snapshot.scale.clone();
      
      if (this.activeHandle.startsWith('translate')) {
        const axis = new THREE.Vector3();
        if (this.activeHandle === 'translate-x') axis.set(1, 0, 0);
        if (this.activeHandle === 'translate-y') axis.set(0, 1, 0);
        if (this.activeHandle === 'translate-z') axis.set(0, 0, 1);
        axis.applyQuaternion(this.snapshot.quaternion).normalize();
        
        let dist = delta.dot(axis);
        if (snapDisp > 0) {
           dist = Math.round(dist / snapDisp) * snapDisp;
           snapped = true;
        }
        newPos.addScaledVector(axis, dist);
      } else if (this.activeHandle.startsWith('plane')) {
        if (snapDisp > 0) {
           delta.x = Math.round(delta.x / snapDisp) * snapDisp;
           delta.y = Math.round(delta.y / snapDisp) * snapDisp;
           delta.z = Math.round(delta.z / snapDisp) * snapDisp;
           snapped = true;
        }
        newPos.add(delta);
      } else if (this.activeHandle.startsWith('rotate')) {
        const center = this.object.position;
        const v1 = new THREE.Vector3().subVectors(this.startIntersection, center).normalize();
        const v2 = new THREE.Vector3().subVectors(this.dragIntersection, center).normalize();
        
        const axis = new THREE.Vector3();
        if (this.activeHandle === 'rotate-x') axis.set(1, 0, 0);
        else if (this.activeHandle === 'rotate-y') axis.set(0, 1, 0);
        else axis.set(0, 0, 1);
        axis.applyQuaternion(this.snapshot.quaternion).normalize();
        
        let angle = Math.atan2(v2.clone().cross(v1).dot(axis), v1.dot(v2));
        if (snapRot > 0) {
            angle = Math.round(angle / snapRot) * snapRot;
            snapped = true;
        }
        
        const q = new THREE.Quaternion().setFromAxisAngle(axis, -angle);
        newQuat.premultiply(q);
      } else if (this.activeHandle.startsWith('scale')) {
        const axis = new THREE.Vector3();
        if (this.activeHandle === 'scale-x') axis.set(1, 0, 0);
        if (this.activeHandle === 'scale-y') axis.set(0, 1, 0);
        if (this.activeHandle === 'scale-z') axis.set(0, 0, 1);
        axis.applyQuaternion(this.snapshot.quaternion).normalize();
        
        const dist = delta.dot(axis);
        const factor = 1 + dist;
        if (this.activeHandle === 'scale-x') newScale.x *= factor;
        if (this.activeHandle === 'scale-y') newScale.y *= factor;
        if (this.activeHandle === 'scale-z') newScale.z *= factor;
      }
      
      const nextTransform = {
        position: newPos,
        quaternion: newQuat,
        scale: newScale
      };
      this.object.position.copy(newPos);
      this.object.quaternion.copy(newQuat);
      this.object.scale.copy(newScale);
      this.options.onChange(nextTransform, this.activeHandle, snapped);
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.activeHandle) return;
    if (this.pointerId !== null) {
       try { this.options.domElement.releasePointerCapture(this.pointerId); } catch {}
    }
    this.activeHandle = null;
    this.pointerId = null;
    this.snapshot = null;
    this.options.onEnd();
  };
  
  private onPointerCancel = () => this.cancel();
  private onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') this.cancel(); };
  private onBlur = () => this.cancel();

  private updatePointer(e: PointerEvent) {
    const rect = this.options.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  attach(transform: GumballTransform, pivot?: THREE.Vector3): void {
    this.attached = true;
    this.object.visible = true;
    this.update(transform);
  }

  detach(): void {
    this.attached = false;
    this.object.visible = false;
  }

  setVisible(visible: boolean): void {
    this.object.visible = visible && this.attached;
  }

  update(transform: GumballTransform): void {
    this.object.position.copy(transform.position);
    this.object.quaternion.copy(transform.quaternion);
    
    const dist = this.options.camera.position.distanceTo(this.object.position);
    let scale = dist * 0.15;
    if (this.options.camera instanceof THREE.OrthographicCamera) {
      scale = (this.options.camera.top - this.options.camera.bottom) / this.options.camera.zoom * 0.15;
    }
    this.object.scale.set(scale, scale, scale);
  }

  cancel(): void {
    if (this.activeHandle && this.snapshot) {
      this.object.position.copy(this.snapshot.position);
      this.object.quaternion.copy(this.snapshot.quaternion);
      this.object.scale.copy(this.snapshot.scale);
      this.options.onCancel(this.snapshot);
    }
    if (this.pointerId !== null) {
      try { this.options.domElement.releasePointerCapture(this.pointerId); } catch {}
    }
    this.activeHandle = null;
    this.pointerId = null;
    this.snapshot = null;
  }

  dispose(): void {
    this.unbindEvents();
    this.geometries.forEach(g => g.dispose());
    this.materials.forEach(m => m.dispose());
    this.object.clear();
  }
}
(window as any).ClippingGumball = ClippingGumball;
