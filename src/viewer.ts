import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import * as FRAGS from "@thatopen/fragments";
import fragmentsWorkerUrl from "@thatopen/fragments/worker?url";
import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { Emitter } from "./events";
import { IfcParameterReader, type ElementParameters } from "./ifc-parameters";
import type { IfcSet } from "./ifc-sets";

export type { ElementParameters, ParamGroup, ParamRow } from "./ifc-parameters";

export type ElementId = number;

export interface ModelLoaded {
  filename: string;
  elementCount: number;
  categories: ReadonlyMap<string, ElementId[]>;
  /** True when loaded via the streaming pipeline; properties panel is unavailable. */
  streamed: boolean;
}

export interface LoadProgress {
  loaded: number;
  total: number;
}

export interface LoadStarted {
  filename: string;
  size?: number;
}

export interface Selection {
  fragmentId: string;
  expressId: ElementId;
}

/** A world-space point, in metres. Plain data so src/ui never imports three. */
export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export type ClipAxis = "x" | "y" | "z";
export type ClipMode = "plane" | "slice" | "box";

export interface ClippingState {
  enabled: boolean;
  mode: ClipMode;
  axis: ClipAxis;
  inverted: boolean;
  planePos: number;
  sliceMin: number;
  sliceMax: number;
  boxMin: Point3;
  boxMax: Point3;
  showHelper: boolean;
}

// 50 mm. The library default of 0.25 (250 mm) grabs the wrong vertex constantly
// at building scale.
const SNAP_DISTANCE_METRES = 0.05;
const PICKER_SIZE_PX = 6;
const IFCOPENINGELEMENT = 3588315303;
export const LARGE_IFC_THRESHOLD_BYTES = 50 * 1024 * 1024;

const QUANTITY_VALUE_KEYS = [
  "LengthValue",
  "AreaValue",
  "VolumeValue",
  "WeightValue",
  "CountValue",
  "TimeValue",
] as const;

function itemValue(item: FRAGS.ItemData, name: string): unknown {
  const value = item[name];
  return value && !Array.isArray(value) ? value.value : undefined;
}

function relatedItems(item: FRAGS.ItemData, name: string): FRAGS.ItemData[] {
  const value = item[name];
  return Array.isArray(value) ? value : [];
}

function itemLocalId(item: FRAGS.ItemData): number | null {
  const value = itemValue(item, "_localId");
  return typeof value === "number" ? value : null;
}

function itemDataToProperties(item: FRAGS.ItemData): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(item)) {
    if (!Array.isArray(value)) properties[name] = value;
  }
  properties.expressID = itemValue(item, "_localId");
  properties.type = itemValue(item, "_category");
  return properties;
}

function fragmentPropertySet(item: FRAGS.ItemData): IfcSet {
  const fallbackId = itemLocalId(item);
  const name = itemValue(item, "Name") ?? `Set_${fallbackId ?? "unknown"}`;
  const props: Record<string, unknown> = {};

  for (const property of relatedItems(item, "HasProperties")) {
    const label = itemValue(property, "Name");
    if (label !== undefined && label !== null) {
      props[String(label)] = itemValue(property, "NominalValue") ?? null;
    }
  }

  for (const quantity of relatedItems(item, "Quantities")) {
    const label = itemValue(quantity, "Name");
    if (label === undefined || label === null) continue;
    let value: unknown = null;
    for (const key of QUANTITY_VALUE_KEYS) {
      const candidate = itemValue(quantity, key);
      if (candidate !== undefined) {
        value = candidate;
        break;
      }
    }
    props[String(label)] = value;
  }

  return { name: String(name), props };
}

export class Viewer {
  readonly onModelLoaded = new Emitter<ModelLoaded>();
  readonly onModelUnloaded = new Emitter<void>();
  readonly onSelection = new Emitter<Selection | null>();
  readonly onLoadProgress = new Emitter<LoadProgress>();
  readonly onLoadStarted = new Emitter<LoadStarted>();
  readonly onMeasureModeChanged = new Emitter<boolean>();
  readonly onMeasureSnapChanged = new Emitter<boolean>();
  readonly onGridVisibleChanged = new Emitter<boolean>();
  readonly onBackEdgesChanged = new Emitter<boolean>();
  readonly onXrayChanged = new Emitter<boolean>();

  private components!: OBC.Components;
  private world!: OBC.SimpleWorld<
    OBC.SimpleScene,
    OBC.SimpleCamera,
    OBC.SimpleRenderer
  >;
  // Same object as world.renderer, held at its concrete type so the edges
  // methods can reach .postproduction -- SimpleWorld types the slot as
  // SimpleRenderer.
  private ppRenderer!: OBF.PostproductionRenderer;
  private grid!: OBC.SimpleGrid;
  private dashedEdgesGroup = new THREE.Group();
  private modelBackEdgesGroup = new THREE.Group();
  private selectionBackEdgesGroup = new THREE.Group();
  private backEdgesEnabled = false;
  private modelBackEdgesBuilt = false;
  private xrayMode = false;
  private ifcLoader!: OBC.IfcLoader;
  private fragmentsManager!: OBC.FragmentsManager;
  private highlighter!: OBF.Highlighter;
  private lengthMeasurement!: OBF.LengthMeasurement;
  private measureMode = false;
  private measureSnapActive = false;

  private currentModel: FRAGS.FragmentsModel | null = null;
  private currentCategories = new Map<string, ElementId[]>();
  private currentFilename = "";
  private currentIsStreamed = false;
  private lastSelection: Selection | null = null;
  private activePlanes: THREE.Plane[] = [];
  private clippingHelpersGroup = new THREE.Group();
  private clippingGizmosGroup = new THREE.Group();
  private gizmos: { proxy: THREE.Mesh; control: TransformControls }[] = [];
  private lastGizmoConfig = "";
  private gizmoDragging = false;
  private clipState: ClippingState = {
    enabled: false,
    mode: "plane",
    axis: "y",
    inverted: false,
    planePos: 0,
    sliceMin: 0,
    sliceMax: 1,
    boxMin: { x: 0, y: 0, z: 0 },
    boxMax: { x: 1, y: 1, z: 1 },
    showHelper: false,
  };
  readonly onClippingChanged = new Emitter<ClippingState>();

  get isDraggingGizmo(): boolean {
    return this.gizmoDragging;
  }

  /**
   * Raw-IFC reader kept open alongside the fragments. OBC's IfcLoader strips
   * every geometry-representation entity from the group's property store, so
   * profile dimensions, extrusions and placements are only reachable this way.
   */
  private paramReader: IfcParameterReader | null = null;
  private initialized = false;
  private edgesPreference = false;
  private hiddenLines = false;
  private lastPreparedResult: {
    cacheId: string;
    filename: string;
    cacheHit: boolean;
  } | null = null;

  private applyRenderStyle(): void {
    this.ppRenderer.postproduction.style = this.hiddenLines
      ? OBF.PostproductionAspect.PEN
      : this.edgesPreference
        ? OBF.PostproductionAspect.COLOR_PEN
        : OBF.PostproductionAspect.COLOR;
    this.updateBackEdgesMaterial();
  }

  private updateBackEdgesMaterial(): void {
    if (!this.modelBackEdgesGroup) return;
    const isPen = this.hiddenLines;
    for (const child of this.modelBackEdgesGroup.children) {
      const ls = child as THREE.LineSegments;
      if (ls.material) {
        const mat = ls.material as THREE.LineDashedMaterial;
        if (mat.isLineDashedMaterial) {
          mat.color.setHex(isPen ? 0x475569 : 0x94a3b8);
          mat.opacity = isPen ? 0.70 : 0.65;
          mat.needsUpdate = true;
        }
      }
    }
    this.world?.renderer?.update();
  }

  async init(container: HTMLElement): Promise<void> {
    const components = new OBC.Components();
    const worlds = components.get(OBC.Worlds);
    const world = worlds.create<
      OBC.SimpleScene,
      OBC.SimpleCamera,
      OBC.SimpleRenderer
    >();
    world.scene = new OBC.SimpleScene(components);
    // PostproductionRenderer extends RendererWith2D, which in turn extends
    // SimpleRenderer and adds a CSS2DRenderer -- what draws measurement labels.
    // That label layer is pointer-events:none, so it does not intercept
    // selection clicks. The composer it adds on top is what can draw outlines.
    const renderer = new OBF.PostproductionRenderer(components, container);
    this.ppRenderer = renderer;
    world.renderer = renderer;
    world.camera = new OBC.SimpleCamera(components);
    world.scene.setup();
    components.init();

    // Bring the composer up once so the first edge toggle does not change the
    // renderer lifecycle as well as its style. COLOR is the normal view;
    // COLOR_PEN is the 3.x supported visible-edge view.
    renderer.postproduction.enabled = true;
    renderer.postproduction.style = OBF.PostproductionAspect.COLOR;
    renderer.postproduction.glossEnabled = false;

    world.scene.three.background = new THREE.Color("#1a1f26");
    world.camera.controls.setLookAt(20, 20, 20, 0, 0, 0);

    const grids = components.get(OBC.Grids);
    this.grid = grids.create(world);
    const grid = this.grid;

    this.dashedEdgesGroup.name = "dashed-back-edges";
    this.modelBackEdgesGroup.name = "model-back-edges";
    this.selectionBackEdgesGroup.name = "selection-back-edges";
    this.dashedEdgesGroup.add(this.modelBackEdgesGroup);
    this.dashedEdgesGroup.add(this.selectionBackEdgesGroup);
    world.scene.three.add(this.dashedEdgesGroup);

    this.clippingHelpersGroup.name = "clipping-helpers";
    world.scene.three.add(this.clippingHelpersGroup);

    this.clippingGizmosGroup.name = "clipping-gizmos";
    world.scene.three.add(this.clippingGizmosGroup);

    // The ground grid uses a shader plane. During the edge-detection pass, Sobel filtering
    // on the grid's lines produces severe artifacts (thick double-lines, moiré at the horizon,
    // and cutting through solid meshes). Temporarily hiding the grid during the edge pass
    // keeps the ground grid clean and smooth in COLOR_PEN mode, and avoids rendering a giant
    // black cage over the screen in PEN (Hidden lines) mode.
    const edgesPass = renderer.postproduction.edgesPass as any;
    const originalEdgesRender = edgesPass.render.bind(edgesPass);
    edgesPass.render = (
      rendererInstance: any,
      writeBuffer: any,
      readBuffer: any,
    ) => {
      const wasVisible = this.grid.three.visible;
      const wasDashedVisible = this.dashedEdgesGroup.visible;
      const wasHelpersVisible = this.clippingHelpersGroup.visible;
      const wasGizmosVisible = this.clippingGizmosGroup.visible;
      this.grid.three.visible = false;
      this.dashedEdgesGroup.visible = false;
      this.clippingHelpersGroup.visible = false;
      this.clippingGizmosGroup.visible = false;
      try {
        originalEdgesRender(rendererInstance, writeBuffer, readBuffer);
      } finally {
        this.grid.three.visible = wasVisible;
        this.dashedEdgesGroup.visible = wasDashedVisible;
        this.clippingHelpersGroup.visible = wasHelpersVisible;
        this.clippingGizmosGroup.visible = wasGizmosVisible;
      }
    };

    // web-ifc settings for regular IFC conversion.
    //  - "./" wasm path → resolves next to the document for both vite dev
    //    and packaged file:// loads.
    //  - MEMORY_LIMIT defaults to 2 GiB; pushing past that on wasm32 causes
    //    "memory access out of bounds". Leave it default.
    //  - TAPE_SIZE bumped to 256 MiB.
    //  - IFCOPENINGELEMENT excluded — door/window holes balloon fragment
    //    counts on big files and aren't visible.
    const wasmConfig = {
      autoSetWasm: false,
      wasm: { path: "./", absolute: false },
      webIfc: {
        COORDINATE_TO_ORIGIN: true,
        TAPE_SIZE: 256 * 1024 * 1024,
      },
    } satisfies Partial<OBC.IfcFragmentSettings>;

    const fragmentsManager = components.get(OBC.FragmentsManager);
    fragmentsManager.init(fragmentsWorkerUrl);
    // init() does not yield until the IFC loader setup below. Publish the
    // initialized manager immediately so synchronous readiness probes cannot
    // observe a partially initialized Viewer.
    this.fragmentsManager = fragmentsManager;
    fragmentsManager.list.onItemSet.add(({ value: model }) => {
      model.useCamera(world.camera.three);
      world.scene.three.add(model.object);
      void fragmentsManager.core.update(true);
    });
    world.camera.controls.addEventListener("rest", () => {
      if (this.currentModel) {
        this.currentModel.useCamera(world.camera.three);
      }
      void fragmentsManager.core.update(true);
    });

    const ifcLoader = components.get(OBC.IfcLoader);
    await ifcLoader.setup(wasmConfig);

    const highlighter = components.get(OBF.Highlighter);
    highlighter.setup({
      world,
      selectMaterialDefinition: {
        color: new THREE.Color("#0080ff"),
        renderedFaces: FRAGS.RenderedFaces.ONE,
        opacity: 1,
        transparent: false,
        preserveOriginalMaterial: true,
        ...({ _explicitProps: ["color", "opacity", "transparent"] } as any),
      },
    });
    highlighter.zoomToSelection = false;

    const origUpdateColors = highlighter.updateColors.bind(highlighter);
    highlighter.updateColors = async () => {
      await origUpdateColors();
      if (this.xrayMode && this.currentModel) {
        await this.currentModel.setOpacity(undefined, 0.4);
        if (this.lastSelection) {
          await this.currentModel.setOpacity([this.lastSelection.expressId], 1);
        }
        await this.fragmentsManager.core.update(true);
      }
      this.world?.renderer?.update();
    };

    const selectEvents = highlighter.events["select"];
    if (selectEvents) {
      selectEvents.onHighlight.add((modelIdMap) => {
        const modelId = Object.keys(modelIdMap)[0];
        if (!modelId) return;
        const ids = modelIdMap[modelId];
        const expressId = ids?.values().next().value as number | undefined;
        if (expressId === undefined) return;
        this.lastSelection = { fragmentId: modelId, expressId };
        this.onSelection.emit(this.lastSelection);
        void this.updateSelectionBackEdges(expressId);
      });
      selectEvents.onClear.add(() => {
        this.lastSelection = null;
        this.onSelection.emit(null);
        this.clearSelectionBackEdges();
      });
    }

    const lengthMeasurement = components.get(OBF.LengthMeasurement);
    lengthMeasurement.world = world;
    lengthMeasurement.snapDistance = SNAP_DISTANCE_METRES;
    lengthMeasurement.pickerSize = PICKER_SIZE_PX;
    lengthMeasurement.units = "mm";
    lengthMeasurement.rounding = 0;

    const raycasters = components.get(OBC.Raycasters);
    const raycaster = raycasters.get(world);
    const dom = renderer.three.domElement;
    if (dom && (raycaster as any)?.mouse) {
      dom.addEventListener("pointerdown", (e) =>
        (raycaster as any).mouse.updateMouseInfo(e),
      );
      dom.addEventListener("click", (e) =>
        (raycaster as any).mouse.updateMouseInfo(e),
      );
      dom.addEventListener("dblclick", () => {
        if (this.currentModel) void this.zoomToFit(true);
      });
    }

    this.components = components;
    this.world = world;
    this.ifcLoader = ifcLoader;
    this.highlighter = highlighter;
    this.lengthMeasurement = lengthMeasurement;
    this.initialized = true;
  }

  async loadIfcPath(filePath: string): Promise<void> {
    const filename = filePath.split(/[\\/]/).pop() ?? "model.ifc";
    const fileSize = await window.electron.getIfcFileSize(filePath);
    this.onLoadStarted.emit({ filename, size: fileSize });

    if (fileSize <= LARGE_IFC_THRESHOLD_BYTES) {
      const buf = await window.electron.readFile(filePath);
      return this.loadIfc(buf, filename);
    }

    this.onLoadProgress.emit({ loaded: 0, total: 100 });
    const unsubscribe = window.electron.onIfcPreprocessProgress?.((p) => {
      this.onLoadProgress.emit({
        loaded: Math.round(p.progress * 100),
        total: 100,
      });
    });

    let fragmentBuffer: ArrayBuffer;
    try {
      const prepared = await window.electron.prepareIfc(filePath);
      this.lastPreparedResult = prepared;
      fragmentBuffer = await window.electron.readPreparedIfc(prepared.cacheId);
    } finally {
      unsubscribe?.();
    }

    const modelId = `${filename}-${THREE.MathUtils.generateUUID()}`;
    const newModel = await this.fragmentsManager.core.load(
      new Uint8Array(fragmentBuffer),
      {
        modelId,
        camera: this.world.camera.three,
      },
    );

    if (this.currentModel) await this.unloadIfc();

    this.currentModel = newModel;
    this.currentFilename = filename;
    this.currentIsStreamed = true;

    await this.fragmentsManager.core.update(true);

    this.onLoadProgress.emit({ loaded: 100, total: 100 });
    await this.classifyAndEmit(newModel, filename, true);
    await this.fitToModel(newModel, false);
  }

  async loadIfc(input: File | ArrayBuffer, filename?: string): Promise<void> {
    const name =
      filename ?? (input instanceof File ? input.name : "model.ifc");
    const buffer =
      input instanceof File
        ? new Uint8Array(await input.arrayBuffer())
        : new Uint8Array(input);

    this.onLoadStarted.emit({ filename: name, size: buffer.byteLength });
    this.onLoadProgress.emit({ loaded: 0, total: buffer.byteLength });

    // Yield briefly so browser paints the loading state before synchronous WASM blocks main thread
    await new Promise((resolve) => setTimeout(resolve, 50));

    await this.loadIfcRegular(buffer, name);
  }

  private async loadIfcRegular(
    buffer: Uint8Array,
    name: string,
  ): Promise<void> {
    let model: FRAGS.FragmentsModel;
    try {
      model = await this.ifcLoader.load(
        buffer,
        true,
        `${name}-${THREE.MathUtils.generateUUID()}`,
        {
          processData: {
            progressCallback: (progress: number, data?: any) => {
              const pct = Math.round(progress * 100);
              const stage = data?.process ? ` [${data.process}]` : "";
              console.log(`[IFC] Parsing & converting: ${pct}%${stage}`);
              this.onLoadProgress.emit({
                loaded: Math.round(progress * buffer.byteLength),
                total: buffer.byteLength,
              });
            },
          },
          instanceCallback: (importer) => {
            importer.classes.elements.delete(IFCOPENINGELEMENT);
          },
        },
      );
    } catch (err) {
      console.error("[IFC] Parsing error:", err);
      this.onLoadProgress.emit({
        loaded: buffer.byteLength,
        total: buffer.byteLength,
      });
      throw new Error(`IFC parse failed: ${(err as Error).message}`);
    }

    if (this.currentModel) await this.unloadIfc();

    this.currentModel = model;
    this.currentFilename = name;
    this.currentIsStreamed = false;

    this.onLoadProgress.emit({
      loaded: buffer.byteLength,
      total: buffer.byteLength,
    });

    await this.fragmentsManager.core.update(true);
    await this.openParameterReader(buffer);
    await this.classifyAndEmit(model, name, false);
    await this.fitToModel(model, false);
  }

  /**
   * Second web-ifc parse of the same buffer, kept open for the model's
   * lifetime. Non-fatal: the properties panel falls back to the fragments'
   * own (much thinner) property store if this can't be opened.
   */
  private async openParameterReader(buffer: Uint8Array): Promise<void> {
    try {
      this.paramReader = await IfcParameterReader.open(buffer);
    } catch (err) {
      console.warn("parameter reader unavailable:", err);
      this.paramReader = null;
    }
  }

  private async classifyAndEmit(
    model: FRAGS.FragmentsModel,
    name: string,
    streamed: boolean,
  ): Promise<void> {
    let categories = new Map<string, ElementId[]>();
    try {
      const names = await model.getCategories();
      const byCategory = await model.getItemsOfCategories(
        names.map((category) => new RegExp(`^${category}$`)),
      );
      for (const [ifcClass, ids] of Object.entries(byCategory)) {
        categories.set(ifcClass, ids);
      }
    } catch {
      categories = new Map();
    }
    this.currentCategories = categories;

    let elementCount = 0;
    for (const ids of categories.values()) elementCount += ids.length;

    this.initClippingStateForModel();

    this.onModelLoaded.emit({
      filename: name,
      elementCount,
      categories,
      streamed,
    });
  }

  async fitToModel(
    model?: FRAGS.FragmentsModel | null,
    transition = false,
  ): Promise<void> {
    const targetModel = model ?? this.currentModel;
    if (!targetModel) return;

    targetModel.object.updateMatrixWorld(true);

    let box: THREE.Box3 = targetModel.box;
    const testVec = new THREE.Vector3();
    let size = box ? box.getSize(testVec) : null;
    let len = size ? size.length() : 0;

    if (!size || !Number.isFinite(len) || len === 0 || box.isEmpty()) {
      box = new THREE.Box3().setFromObject(targetModel.object);
      size = box.getSize(testVec);
      len = size.length();
    }

    if (!size || !Number.isFinite(len) || len === 0 || box.isEmpty()) {
      targetModel.object.traverse((child) => {
        if ((child as any).geometry) {
          (child as any).geometry.computeBoundingBox?.();
          const geomBox = (child as any).geometry.boundingBox as THREE.Box3 | undefined;
          if (geomBox) {
            const worldGeomBox = geomBox.clone().applyMatrix4(child.matrixWorld);
            if (box.isEmpty()) {
              box.copy(worldGeomBox);
            } else {
              box.union(worldGeomBox);
            }
          }
        }
      });
      size = box.getSize(testVec);
      len = size.length();
    }

    if (!Number.isFinite(len) || len === 0 || box.isEmpty()) {
      console.warn("[IFC] Model bounding box is empty or zero size for model:", targetModel);
      return;
    }

    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 0.1);

    if (this.grid?.three) {
      // Place the ground grid at the base of the model (box.min.y) so it sits under the building
      // rather than cutting through upper storeys or appearing above negative-elevation structures.
      // Offset slightly downwards by 0.01 to prevent z-fighting with the bottom slab/foundation faces.
      this.grid.three.position.y = box.min.y - 0.01;
      if (this.grid.material?.uniforms?.uDistance) {
        this.grid.material.uniforms.uDistance.value = Math.max(500, maxDim * 5);
      }
    }

    // Dynamically adjust near and far clipping planes so models of ANY scale
    // (from millimetres up to kilometres or large survey coordinates) are fully visible without clipping.
    const camera = this.world.camera.three;
    const requiredFar = Math.max(10000, maxDim * 50, center.length() + maxDim * 10);
    const requiredNear = Math.min(0.1, Math.max(0.001, maxDim / 5000));

    if (camera.far < requiredFar) {
      camera.far = requiredFar;
    }
    if (camera.near > requiredNear) {
      camera.near = requiredNear;
    }
    camera.updateProjectionMatrix();

    const controls = this.world.camera.controls;
    controls.maxDistance = Math.max(controls.maxDistance, camera.far * 0.8);
    controls.minDistance = Math.min(controls.minDistance, camera.near * 2);

    const fovRad = THREE.MathUtils.degToRad(
      camera instanceof THREE.PerspectiveCamera ? camera.fov : 60,
    );
    const dist = (maxDim / 2) / Math.tan(fovRad / 2);
    const offset = Math.max(len, dist);

    console.log(
      `[IFC] Auto zoom to fit: center=(${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)}), ` +
      `dimensions=(${size.x.toFixed(2)}, ${size.y.toFixed(2)}, ${size.z.toFixed(2)}), ` +
      `distance=${dist.toFixed(2)}, far=${camera.far}, gridY=${this.grid?.three?.position.y?.toFixed(2) ?? 0}`,
    );

    await controls.setLookAt(
      center.x + offset,
      center.y + offset,
      center.z + offset,
      center.x,
      center.y,
      center.z,
      transition,
    );

    controls.update(0.016);
    targetModel.useCamera(camera);
    await this.fragmentsManager.core.update(true);
    if (this.backEdgesEnabled) {
      await this.buildModelBackEdges();
    }
    this.world.renderer?.update();
  }

  zoomToFit(transition = true): Promise<void> {
    return this.fitToModel(this.currentModel, transition);
  }

  unloadIfc(): Promise<void> {
    if (!this.currentModel) return Promise.resolve();
    const model = this.currentModel;
    this.setMeasureMode(false);
    this.clearMeasurements();
    this.clearModelBackEdges();
    this.clearSelectionBackEdges();
    try {
      void this.highlighter?.clear("select");
    } catch {
      /* ignore */
    }
    // Reset X-Ray state without waiting (model will be disposed anyway)
    if (this.xrayMode) {
      this.xrayMode = false;
      this.onXrayChanged.emit(false);
    }
    this.world.scene.three.remove(model.object);
    if (this.grid?.three) {
      this.grid.three.position.y = 0;
      if (this.grid.material?.uniforms?.uDistance) {
        this.grid.material.uniforms.uDistance.value = 500;
      }
    }
    this.paramReader?.close();
    this.paramReader = null;
    this.currentModel = null;
    this.currentCategories.clear();
    this.currentFilename = "";
    this.currentIsStreamed = false;
    this.lastSelection = null;
    this.setClippingPlane(false);
    this.onModelUnloaded.emit();
    return this.fragmentsManager.core.disposeModel(model.modelId).catch((err) => {
      console.warn("fragment model disposal failed:", err);
    });
  }


  getCategories(): ReadonlyMap<string, ElementId[]> {
    return this.currentCategories;
  }

  getCurrentFilename(): string {
    return this.currentFilename;
  }

  isStreamed(): boolean {
    return this.currentIsStreamed;
  }

  /**
   * Toggle screen-space outline rendering.
   *
   * Only the edge pass is switched. Postproduction as a whole stays on for the
   * session (see init) because Postproduction.initialize() mutates the shared
   * WebGLRenderer once and irreversibly -- toggling `enabled` instead leaves
   * the pre-initialisation render unreachable, so turning edges off would not
   * restore the frame you started with (measured: 13% of pixels changed, peak
   * channel delta 151).
   */
  setEdges(on: boolean): void {
    this.edgesPreference = on;
    if (!this.hiddenLines) this.applyRenderStyle();
  }

  edgesOn(): boolean {
    return this.edgesPreference;
  }

  async setHiddenLines(on: boolean): Promise<void> {
    this.hiddenLines = on;
    this.applyRenderStyle();
    if (on) {
      this.modelBackEdgesGroup.visible = true;
      await this.buildModelBackEdges();
    } else {
      this.modelBackEdgesGroup.visible = this.backEdgesEnabled;
      this.world?.renderer?.update();
    }
  }

  hiddenLinesOn(): boolean {
    return this.hiddenLines;
  }

  debugPostproductionStyle(): string {
    const style = this.ppRenderer.postproduction.style;
    return OBF.PostproductionAspect[style] ?? String(style);
  }

  /** Gloss is a library default we deliberately turn off. For tests. */
  debugGlossEnabled(): boolean {
    return this.ppRenderer.postproduction.glossEnabled;
  }

  /** Renderer-level flag the clipper depends on. Exposed for regression tests. */
  debugLocalClippingEnabled(): boolean {
    return this.world.renderer!.three.localClippingEnabled;
  }

  /** Clipping planes currently registered with the renderer. For tests. */
  debugClippingPlaneCount(): number {
    return this.world.renderer?.three.clippingPlanes.length ?? 0;
  }

  /** Effective vertex-snap radius in metres. Exposed for regression tests. */
  debugSnapDistance(): number {
    return this.lengthMeasurement.snapDistance;
  }

  debugFragmentsInitialized(): boolean {
    return Boolean(this.fragmentsManager?.initialized);
  }

  debugInitialized(): boolean {
    return this.initialized;
  }

  debugLastPrepared(): {
    cacheId: string;
    filename: string;
    cacheHit: boolean;
  } | null {
    return this.lastPreparedResult;
  }

  setGridVisible(visible: boolean): void {
    if (this.grid) {
      this.grid.visible = visible;
      this.onGridVisibleChanged.emit(visible);
      this.world?.renderer?.update();
    }
  }

  isGridVisible(): boolean {
    return this.grid?.visible ?? false;
  }

  getGridElevation(): number {
    return this.grid?.three?.position.y ?? 0;
  }

  setGridElevation(y: number): void {
    if (this.grid?.three) {
      this.grid.three.position.y = y;
      this.world?.renderer?.update();
    }
  }

  debugGridElevation(): number {
    return this.getGridElevation();
  }

  // ---------------------------------------------------------------------------
  // Dashed back-edges (whole model + selected element)
  // ---------------------------------------------------------------------------

  /**
   * Build LineDashedMaterial line segments from all meshes in the model and
   * render them with depthFunc=GreaterDepth so they show as dashed lines through
   * occluding surfaces (matching Google SketchUp "Back Edges" style, shortcut B/K).
   * Cached after the first build; toggles are instantaneous.
   */
  private async buildModelBackEdges(): Promise<void> {
    if (!this.currentModel) return;
    if (this.modelBackEdgesBuilt) {
      this.modelBackEdgesGroup.visible = true;
      this.world?.renderer?.update();
      return;
    }

    this.clearModelBackEdges();

    const model = this.currentModel;
    const modelObj = model.object;
    modelObj.updateMatrixWorld(true);

    let box = model.box;
    if (!box || box.isEmpty()) {
      box = new THREE.Box3().setFromObject(modelObj);
    }
    const testVec = new THREE.Vector3();
    const size = box.getSize(testVec);
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const dashSize = Math.max(0.04, Math.min(0.25, maxDim / 150));
    const gapSize = dashSize * 0.6;

    const isPen = this.hiddenLines;
    const dashedMat = new THREE.LineDashedMaterial({
      color: isPen ? 0x475569 : 0x94a3b8,
      depthFunc: THREE.GreaterDepth,
      depthWrite: false,
      transparent: true,
      opacity: isPen ? 0.70 : 0.65,
      dashSize,
      gapSize,
    });

    let geometryParts: any[][];
    try {
      const ids = await model.getItemsIds();
      geometryParts = await model.getItemsGeometry(ids);
    } catch (err) {
      console.warn("[IFC] Failed to retrieve model geometries for back edges:", err);
      return;
    }

    if (!geometryParts || geometryParts.length === 0) return;

    // Collect all EdgesGeometry position buffers
    const edgePositionArrays: Float32Array[] = [];
    let totalFloats = 0;

    for (const parts of geometryParts) {
      for (const part of parts) {
        const positions: Float32Array = part.positions;
        const indices: Uint32Array = part.indices;
        const transform: any = part.transform;
        if (!positions || !indices || positions.length === 0) continue;

        try {
          const triGeom = new THREE.BufferGeometry();
          triGeom.setAttribute(
            "position",
            new THREE.BufferAttribute(new Float32Array(positions), 3),
          );
          triGeom.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));

          const mat4 = new THREE.Matrix4();
          if (transform) {
            if (Array.isArray(transform) && transform.length >= 16) {
              mat4.fromArray(transform);
            } else if (transform.elements && transform.elements.length >= 16) {
              mat4.fromArray(transform.elements);
            }
          }
          triGeom.applyMatrix4(mat4);
          triGeom.applyMatrix4(modelObj.matrixWorld);

          const edgesGeom = new THREE.EdgesGeometry(triGeom, 24);
          triGeom.dispose();

          const posAttr = edgesGeom.attributes.position;
          if (posAttr && posAttr.count > 0) {
            const arr = posAttr.array as Float32Array;
            edgePositionArrays.push(arr);
            totalFloats += arr.length;
          }
        } catch (err) {
          console.warn("[IFC] Failed to build back edges for part:", err);
        }
      }
    }

    if (totalFloats > 0) {
      const mergedArray = new Float32Array(totalFloats);
      let offset = 0;
      for (const arr of edgePositionArrays) {
        mergedArray.set(arr, offset);
        offset += arr.length;
      }
      const combinedGeom = new THREE.BufferGeometry();
      const posAttr = new THREE.BufferAttribute(mergedArray, 3);
      combinedGeom.setAttribute("position", posAttr);

      // Compute line distances per segment so every edge has crisp dashes from the start
      const distances = new Float32Array(totalFloats / 3);
      const vA = new THREE.Vector3();
      const vB = new THREE.Vector3();
      for (let i = 0; i < posAttr.count; i += 2) {
        vA.fromBufferAttribute(posAttr, i);
        vB.fromBufferAttribute(posAttr, i + 1);
        distances[i] = 0;
        distances[i + 1] = vA.distanceTo(vB);
      }
      combinedGeom.setAttribute(
        "lineDistance",
        new THREE.BufferAttribute(distances, 1),
      );

      const line = new THREE.LineSegments(combinedGeom, dashedMat);
      line.renderOrder = 2;
      this.modelBackEdgesGroup.add(line);
    }

    this.modelBackEdgesBuilt = true;
    this.modelBackEdgesGroup.visible = this.backEdgesEnabled || this.hiddenLines;
    this.world?.renderer?.update();
  }

  /** Remove and dispose all cached model-wide dashed back-edge line segments. */
  clearModelBackEdges(): void {
    const group = this.modelBackEdgesGroup;
    for (const child of [...group.children]) {
      const ls = child as THREE.LineSegments;
      ls.geometry?.dispose();
      if (Array.isArray(ls.material)) {
        ls.material.forEach((m) => m.dispose());
      } else {
        (ls.material as THREE.Material)?.dispose();
      }
      group.remove(child);
    }
    this.modelBackEdgesBuilt = false;
    this.modelBackEdgesGroup.visible = false;
    this.world?.renderer?.update();
  }

  /**
   * Build LineDashedMaterial line segments for the selected element in accent color.
   */
  async updateSelectionBackEdges(expressId?: number | null): Promise<void> {
    this.clearSelectionBackEdges();
    if (!this.backEdgesEnabled || !this.currentModel || expressId == null) return;

    let geometryParts: any[][];
    try {
      geometryParts = await this.currentModel.getItemsGeometry([expressId]);
    } catch {
      return;
    }
    if (!geometryParts || geometryParts.length === 0) return;

    const solidMat = new THREE.LineBasicMaterial({
      color: 0x0080ff,
      depthFunc: THREE.LessEqualDepth,
      depthWrite: false,
      transparent: true,
      opacity: 0.9,
    });
    const dashedMat = new THREE.LineDashedMaterial({
      color: 0x0080ff,
      depthFunc: THREE.GreaterDepth,
      depthWrite: false,
      transparent: true,
      opacity: 0.6,
      dashSize: 0.1,
      gapSize: 0.06,
    });

    for (const parts of geometryParts) {
      for (const part of parts) {
        const positions: Float32Array = part.positions;
        const indices: Uint32Array = part.indices;
        const transform: any = part.transform;
        if (!positions || !indices || positions.length === 0) continue;

        const triGeom = new THREE.BufferGeometry();
        triGeom.setAttribute(
          "position",
          new THREE.BufferAttribute(new Float32Array(positions), 3),
        );
        triGeom.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));

        const mat4 = new THREE.Matrix4();
        if (transform) {
          if (Array.isArray(transform) && transform.length >= 16) {
            mat4.fromArray(transform);
          } else if (transform.elements && transform.elements.length >= 16) {
            mat4.fromArray(transform.elements);
          }
        }
        triGeom.applyMatrix4(mat4);
        if (this.currentModel) {
          triGeom.applyMatrix4(this.currentModel.object.matrixWorld);
        }

        const edgesGeom = new THREE.EdgesGeometry(triGeom, 15);
        triGeom.dispose();

        const solidLines = new THREE.LineSegments(edgesGeom, solidMat.clone());
        solidLines.renderOrder = 1;
        this.selectionBackEdgesGroup.add(solidLines);

        const posAttr = edgesGeom.attributes.position;
        if (posAttr && posAttr.count > 0) {
          const distances = new Float32Array(posAttr.count);
          const vA = new THREE.Vector3();
          const vB = new THREE.Vector3();
          for (let i = 0; i < posAttr.count; i += 2) {
            vA.fromBufferAttribute(posAttr, i);
            vB.fromBufferAttribute(posAttr, i + 1);
            distances[i] = 0;
            distances[i + 1] = vA.distanceTo(vB);
          }
          edgesGeom.setAttribute(
            "lineDistance",
            new THREE.BufferAttribute(distances, 1),
          );
        }

        const dashedLines = new THREE.LineSegments(edgesGeom, dashedMat.clone());
        dashedLines.renderOrder = 2;
        this.selectionBackEdgesGroup.add(dashedLines);
      }
    }

    this.selectionBackEdgesGroup.visible = true;
    this.world?.renderer?.update();
  }

  /** Remove all dashed back-edge lines for the current selection. */
  clearSelectionBackEdges(): void {
    const group = this.selectionBackEdgesGroup;
    for (const child of [...group.children]) {
      const ls = child as THREE.LineSegments;
      ls.geometry?.dispose();
      if (Array.isArray(ls.material)) {
        ls.material.forEach((m) => m.dispose());
      } else {
        (ls.material as THREE.Material)?.dispose();
      }
      group.remove(child);
    }
    this.selectionBackEdgesGroup.visible = false;
    this.world?.renderer?.update();
  }

  /** Toggle dashed back-edges for the model and selection. */
  async setBackEdges(enabled: boolean): Promise<void> {
    this.backEdgesEnabled = enabled;
    this.onBackEdgesChanged.emit(enabled);
    if (enabled) {
      this.modelBackEdgesGroup.visible = true;
      if (this.lastSelection) {
        void this.updateSelectionBackEdges(this.lastSelection.expressId);
      }
      await this.buildModelBackEdges();
    } else {
      this.modelBackEdgesGroup.visible = this.hiddenLines;
      this.selectionBackEdgesGroup.visible = false;
      this.world?.renderer?.update();
    }
  }

  backEdgesOn(): boolean {
    return this.backEdgesEnabled;
  }


  // ---------------------------------------------------------------------------
  // X-Ray mode (full-model semi-transparency)
  // ---------------------------------------------------------------------------

  /**
   * Toggle X-Ray mode: makes all model geometry semi-transparent (~40% opacity)
   * so interior elements (columns, framing, pipes) are visible through walls.
   * Uses FragmentsModel.setOpacity/resetOpacity — GPU-only, 60fps, zero extra geometry.
   */
  async setXray(on: boolean): Promise<void> {
    this.xrayMode = on;
    const model = this.currentModel;
    if (model) {
      if (on) {
        await model.setOpacity(undefined, 0.4);
      } else {
        await model.resetOpacity(undefined);
      }
      await this.fragmentsManager.core.update(true);
      this.world?.renderer?.update();
    }
    this.onXrayChanged.emit(on);
  }

  xrayOn(): boolean {
    return this.xrayMode;
  }

  /** Whether the live ruler cursor is currently snapped to a vertex. */
  isMeasureSnapActive(): boolean {
    return this.measureSnapActive;
  }

  /**
   * Unit and schema metadata for the loaded model. Null when the raw parameter
   * reader is unavailable, i.e. for streamed models.
   */
  getModelUnits(): {
    schema: string;
    lengthUnit: string;
    lengthToMetres: number;
  } | null {
    if (!this.paramReader) return null;
    return {
      schema: this.paramReader.schema,
      lengthUnit: this.paramReader.lengthUnit,
      lengthToMetres: this.paramReader.lengthToMetres,
    };
  }

  /**
   * Measuring and selecting both want the single click, so they are mutually
   * exclusive. This method is the only place that knows that; scattering the
   * inversion across the UI is how the two tools end up fighting.
   */
  setMeasureMode(on: boolean): void {
    if (this.measureMode === on) return;
    this.measureMode = on;
    this.lengthMeasurement.enabled = on;
    (this.lengthMeasurement as any).lastPick = null;
    this.highlighter.enabled = !on;
    this.setMeasureSnapActive(false);
    if (on) {
      try {
        this.highlighter.clear();
      } catch {
        /* nothing selected */
      }
      this.lastSelection = null;
      this.onSelection.emit(null);
    }
    this.onMeasureModeChanged.emit(on);
  }

  isMeasureMode(): boolean {
    return this.measureMode;
  }

  private setMeasureSnapActive(active: boolean): void {
    if (this.measureSnapActive === active) return;
    this.measureSnapActive = active;
    this.onMeasureSnapChanged.emit(active);
  }

  /**
   * Anchors the first point, or completes the line on the second call. The
   * library's own `create` toggles between those two states.
   */
  async placeMeasurePoint(): Promise<void> {
    if (!this.measureMode) return;
    const lm = this.lengthMeasurement as any;
    try {
      const raycaster = this.components.get(OBC.Raycasters).get(this.world);
      const hit = await raycaster.castRay();
      if (hit?.point) {
        lm.lastPick = hit;
        if (lm.isDragging && lm._temp?.line) {
          lm._temp.line.end.copy(hit.point);
          if (lm._temp.dimension) {
            lm._temp.dimension.end = lm._temp.line.end;
          }
        }
      }
    } catch {
      /* raycast fallback */
    }
    await this.lengthMeasurement.create();
  }

  clearMeasurements(): void {
    this.lengthMeasurement.list.clear();
  }

  measurementCount(): number {
    return this.lengthMeasurement.list.size;
  }

  /** Adds a dimension between two world-space points, in metres. */
  measureBetween(a: Point3, b: Point3): void {
    this.lengthMeasurement.list.add(
      new OBF.Line(
        new THREE.Vector3(a.x, a.y, a.z),
        new THREE.Vector3(b.x, b.y, b.z),
      ),
    );
  }

  async setCategoryVisible(
    ifcClass: string,
    visible: boolean,
  ): Promise<void> {
    const model = this.currentModel;
    const ids = this.currentCategories.get(ifcClass);
    if (!model || !ids?.length) return;
    await model.setVisible(ids, visible);
    await this.fragmentsManager.core.update(true);
  }

  async isolateCategory(ifcClass: string): Promise<void> {
    await Promise.all(
      [...this.currentCategories.keys()].map((category) =>
        this.setCategoryVisible(category, category === ifcClass),
      ),
    );
  }

  async showAllCategories(): Promise<void> {
    const model = this.currentModel;
    if (!model) return;
    await model.setVisible(undefined, true);
    await this.fragmentsManager.core.update(true);
  }

  /**
   * Full parameter set for an element — profile dimensions, extrusion,
   * derived geometry, material and any property sets. Null when the raw reader
   * isn't available (streamed models, or a failed second parse), in which case
   * callers should fall back to getProperties/getPropertySets.
   */
  getElementParameters(expressId: ElementId): ElementParameters | null {
    if (!this.currentModel || !this.paramReader) return null;
    try {
      return this.paramReader.getElementParameters(expressId);
    } catch (err) {
      console.warn("parameter read failed:", err);
      return null;
    }
  }

  async getProperties(
    expressId: ElementId,
  ): Promise<Record<string, unknown> | null> {
    const model = this.currentModel;
    if (!model) return null;
    if (this.currentIsStreamed) return null; // properties not tiled in v1
    const [item] = await model.getItemsData([expressId]);
    return item ? itemDataToProperties(item) : null;
  }

  async getPropertySets(expressId: ElementId): Promise<IfcSet[]> {
    const model = this.currentModel;
    if (!model) return [];
    if (this.currentIsStreamed) return [];
    const [item] = await model.getItemsData([expressId], {
      attributesDefault: true,
      relations: {
        IsDefinedBy: { attributes: true, relations: true },
        DefinesOccurrence: { attributes: false, relations: false },
      },
    });
    if (!item) return [];
    return relatedItems(item, "IsDefinedBy").map(fragmentPropertySet);
  }

  /**
   * Initializes default clipping plane state based on the current model bounds.
   */
  private initClippingStateForModel(): void {
    const box = this.getModelBoundingBox();
    if (!box) return;
    const centerY = (box.min.y + box.max.y) / 2;
    const spanY = box.max.y - box.min.y;
    this.clipState = {
      enabled: false,
      mode: "plane",
      axis: "y",
      inverted: false,
      planePos: centerY,
      sliceMin: box.min.y + spanY * 0.25,
      sliceMax: box.min.y + spanY * 0.75,
      boxMin: { x: box.min.x, y: box.min.y, z: box.min.z },
      boxMax: { x: box.max.x, y: box.max.y, z: box.max.z },
      showHelper: false,
    };
  }

  /**
   * Returns current clipping configuration.
   */
  getClippingState(): Readonly<ClippingState> {
    return { ...this.clipState };
  }

  /**
   * Updates clipping configuration and applies the resulting planes to the renderer.
   */
  setClippingState(updates: Partial<ClippingState>): void {
    const prevAxis = this.clipState.axis;
    this.clipState = { ...this.clipState, ...updates };

    // When switching axis without specifying a plane position, reset to that axis's center and slice defaults
    if (updates.axis && updates.axis !== prevAxis && updates.planePos === undefined) {
      const range = this.getModelAxisRange(this.clipState.axis);
      if (range) {
        this.clipState.planePos = (range.min + range.max) / 2;
        const span = range.max - range.min;
        this.clipState.sliceMin = range.min + span * 0.25;
        this.clipState.sliceMax = range.min + span * 0.75;
      }
    }

    this.syncClippingPlanes();
    this.onClippingChanged.emit(this.clipState);
  }

  /**
   * Cleans up 3D wireframe helpers.
   */
  private clearClippingHelpers(): void {
    while (this.clippingHelpersGroup.children.length > 0) {
      const child = this.clippingHelpersGroup.children[0] as any;
      this.clippingHelpersGroup.remove(child);
      child.dispose?.();
      child.geometry?.dispose?.();
      if (Array.isArray(child.material)) {
        child.material.forEach((m: any) => m?.dispose?.());
      } else {
        child.material?.dispose?.();
      }
    }
  }

  /**
   * Synchronizes active THREE.Plane instances with the renderer.
   */
  private syncClippingPlanes(): void {
    const renderer = this.world?.renderer;
    if (!renderer) return;

    this.clearClippingHelpers();

    if (!this.clipState.enabled || !this.currentModel) {
      for (const p of this.activePlanes) {
        renderer.setPlane(false, p);
      }
      this.activePlanes = [];
      this.world?.renderer?.update();
      return;
    }

    const desiredPlanes: THREE.Plane[] = [];
    const { mode, axis, inverted, planePos, sliceMin, sliceMax, boxMin, boxMax, showHelper } = this.clipState;

    if (mode === "plane") {
      const normal = new THREE.Vector3();
      let constant = 0;
      if (axis === "x") {
        if (!inverted) { normal.set(-1, 0, 0); constant = planePos; }
        else { normal.set(1, 0, 0); constant = -planePos; }
      } else if (axis === "y") {
        if (!inverted) { normal.set(0, -1, 0); constant = planePos; }
        else { normal.set(0, 1, 0); constant = -planePos; }
      } else { // z
        if (!inverted) { normal.set(0, 0, -1); constant = planePos; }
        else { normal.set(0, 0, 1); constant = -planePos; }
      }
      const plane = new THREE.Plane(normal, constant);
      desiredPlanes.push(plane);

      if (showHelper) {
        const box = this.getModelBoundingBox();
        const s = box ? Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) * 1.5 : 20;
        this.clippingHelpersGroup.add(new THREE.PlaneHelper(plane, s, 0xf0883e));
      }
    } else if (mode === "slice") {
      const nMin = new THREE.Vector3();
      const nMax = new THREE.Vector3();
      if (axis === "x") {
        nMin.set(1, 0, 0);
        nMax.set(-1, 0, 0);
      } else if (axis === "y") {
        nMin.set(0, 1, 0);
        nMax.set(0, -1, 0);
      } else {
        nMin.set(0, 0, 1);
        nMax.set(0, 0, -1);
      }
      const minP = Math.min(sliceMin, sliceMax);
      const maxP = Math.max(sliceMin, sliceMax);
      const plane1 = new THREE.Plane(nMin, -minP);
      const plane2 = new THREE.Plane(nMax, maxP);
      desiredPlanes.push(plane1, plane2);

      if (showHelper) {
        const box = this.getModelBoundingBox();
        const s = box ? Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) * 1.5 : 20;
        this.clippingHelpersGroup.add(new THREE.PlaneHelper(plane1, s, 0x58a6ff));
        this.clippingHelpersGroup.add(new THREE.PlaneHelper(plane2, s, 0xf0883e));
      }
    } else if (mode === "box") {
      const minX = Math.min(boxMin.x, boxMax.x);
      const maxX = Math.max(boxMin.x, boxMax.x);
      const minY = Math.min(boxMin.y, boxMax.y);
      const maxY = Math.max(boxMin.y, boxMax.y);
      const minZ = Math.min(boxMin.z, boxMax.z);
      const maxZ = Math.max(boxMin.z, boxMax.z);

      const pX1 = new THREE.Plane(new THREE.Vector3(1, 0, 0), -minX);
      const pX2 = new THREE.Plane(new THREE.Vector3(-1, 0, 0), maxX);
      const pY1 = new THREE.Plane(new THREE.Vector3(0, 1, 0), -minY);
      const pY2 = new THREE.Plane(new THREE.Vector3(0, -1, 0), maxY);
      const pZ1 = new THREE.Plane(new THREE.Vector3(0, 0, 1), -minZ);
      const pZ2 = new THREE.Plane(new THREE.Vector3(0, 0, -1), maxZ);
      desiredPlanes.push(pX1, pX2, pY1, pY2, pZ1, pZ2);

      if (showHelper) {
        const b3 = new THREE.Box3(
          new THREE.Vector3(minX, minY, minZ),
          new THREE.Vector3(maxX, maxY, maxZ),
        );
        this.clippingHelpersGroup.add(new THREE.Box3Helper(b3, new THREE.Color(0xf0883e)));
      }
    }

    for (const p of this.activePlanes) {
      renderer.setPlane(false, p);
    }
    this.activePlanes = desiredPlanes;
    for (const p of this.activePlanes) {
      renderer.setPlane(true, p);
    }

    this.world?.renderer?.update();
    this.syncGizmos();
  }

  private syncGizmos(): void {
    if (this.gizmoDragging) return;

    const { mode, axis, planePos, sliceMin, sliceMax, boxMin, boxMax, enabled, showHelper } = this.clipState;
    const configStr = `${enabled}-${showHelper}-${mode}-${axis}`;
    const structuralChange = configStr !== this.lastGizmoConfig;
    this.lastGizmoConfig = configStr;

    if (structuralChange) {
      for (const g of this.gizmos) {
        g.control.detach();
        g.control.dispose();
        this.clippingGizmosGroup.remove(g.proxy);
        this.clippingGizmosGroup.remove(g.control as any);
      }
      this.gizmos = [];

      if (!enabled || !showHelper || !this.currentModel) {
        this.world?.renderer?.update();
        return;
      }

      const box = this.getModelBoundingBox();
      const center = box ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3();

      const createGizmo = (
        gizmoAxis: ClipAxis,
        initialPos: number,
        onDrag: (val: number) => void
      ) => {
        const proxy = new THREE.Mesh(
          new THREE.BoxGeometry(0.1, 0.1, 0.1),
          new THREE.MeshBasicMaterial({ visible: false })
        );
        proxy.position.copy(center);
        proxy.position[gizmoAxis] = initialPos;
        this.clippingGizmosGroup.add(proxy);

        const control = new TransformControls(
          this.world.camera.three,
          this.world.renderer!.three.domElement
        );
        control.attach(proxy);
        control.showX = gizmoAxis === "x";
        control.showY = gizmoAxis === "y";
        control.showZ = gizmoAxis === "z";
        control.showXY = false;
        control.showXZ = false;
        control.showYZ = false;
        control.size = 1.25;
        control.setMode("translate");

        control.addEventListener("dragging-changed", (event: any) => {
          this.gizmoDragging = event.value;
          this.world.camera.controls.enabled = !event.value;
          if (!event.value) this.onClippingChanged.emit(this.clipState);
        });

        control.addEventListener("change", () => {
          if (this.gizmoDragging) {
            onDrag(proxy.position[gizmoAxis]);
          }
        });

        this.clippingGizmosGroup.add(control as any);
        this.gizmos.push({ proxy, control });
      };

      if (mode === "plane") {
        createGizmo(axis, planePos, (val) => this.setClippingState({ planePos: val }));
      } else if (mode === "slice") {
        createGizmo(axis, sliceMin, (val) => this.setClippingState({ sliceMin: val }));
        createGizmo(axis, sliceMax, (val) => this.setClippingState({ sliceMax: val }));
      } else if (mode === "box") {
        createGizmo("x", boxMin.x, (val) => this.setClippingState({ boxMin: { ...this.clipState.boxMin, x: val } }));
        createGizmo("x", boxMax.x, (val) => this.setClippingState({ boxMax: { ...this.clipState.boxMax, x: val } }));
        createGizmo("y", boxMin.y, (val) => this.setClippingState({ boxMin: { ...this.clipState.boxMin, y: val } }));
        createGizmo("y", boxMax.y, (val) => this.setClippingState({ boxMax: { ...this.clipState.boxMax, y: val } }));
        createGizmo("z", boxMin.z, (val) => this.setClippingState({ boxMin: { ...this.clipState.boxMin, z: val } }));
        createGizmo("z", boxMax.z, (val) => this.setClippingState({ boxMax: { ...this.clipState.boxMax, z: val } }));
      }
    } else {
      // Not a structural change, just sync proxy positions
      if (this.gizmos.length > 0 && enabled && showHelper && this.currentModel) {
        if (mode === "plane" && this.gizmos[0]) {
          this.gizmos[0].proxy.position[axis] = planePos;
        } else if (mode === "slice" && this.gizmos.length >= 2) {
          this.gizmos[0].proxy.position[axis] = sliceMin;
          this.gizmos[1].proxy.position[axis] = sliceMax;
        } else if (mode === "box" && this.gizmos.length >= 6) {
          this.gizmos[0].proxy.position["x"] = boxMin.x;
          this.gizmos[1].proxy.position["x"] = boxMax.x;
          this.gizmos[2].proxy.position["y"] = boxMin.y;
          this.gizmos[3].proxy.position["y"] = boxMax.y;
          this.gizmos[4].proxy.position["z"] = boxMin.z;
          this.gizmos[5].proxy.position["z"] = boxMax.z;
        }
      }
    }
  }

  /**
   * Horizontal clipping plane at `height`, hiding everything above it.
   *
   * Deliberately does not use OBC.Clipper. Its SimplePlane constructor builds a
   * three TransformControls drag gizmo and then does
   * `controls.object.children[0].children[0].add(...)`. Since three's Controls
   * refactor, `controls.object` is the object the gizmo is *attached to* — here
   * a helper whose single child is a plain mesh with no children — so that
   * indexes undefined and every activation threw. (OBC also adds
   * `controls.object` to the scene rather than `controls.getHelper()`.)
   *
   * We drive the plane from a slider and never need the gizmo, so we hold a
   * plain THREE.Plane and register it with the renderer, which is the same
   * mechanism SimplePlane's own `enabled` setter uses.
   */
  setClippingPlane(enabled: boolean, height = 0): void {
    if (!enabled) {
      this.clearClipping();
      return;
    }
    this.setClippingState({
      enabled: true,
      mode: "plane",
      axis: "y",
      inverted: false,
      planePos: height,
    });
  }

  /**
   * Clears all clipping planes and helpers.
   */
  clearClipping(): void {
    this.setClippingState({ enabled: false });
  }

  /**
   * Fits the section box tightly around the currently selected element (plus padding).
   * Automatically activates Section Box mode.
   */
  async fitSectionBoxToSelection(padding = 0.5): Promise<boolean> {
    const model = this.currentModel;
    if (!model || !this.lastSelection) return false;

    let selBox: THREE.Box3 | null = null;
    try {
      selBox = await model.getMergedBox([this.lastSelection.expressId]);
    } catch {
      return false;
    }
    if (!selBox || selBox.isEmpty()) return false;

    selBox.expandByScalar(padding);

    const modelBox = this.getModelBoundingBox();
    if (modelBox) {
      selBox.min.x = Math.max(selBox.min.x, modelBox.min.x);
      selBox.min.y = Math.max(selBox.min.y, modelBox.min.y);
      selBox.min.z = Math.max(selBox.min.z, modelBox.min.z);
      selBox.max.x = Math.min(selBox.max.x, modelBox.max.x);
      selBox.max.y = Math.min(selBox.max.y, modelBox.max.y);
      selBox.max.z = Math.min(selBox.max.z, modelBox.max.z);
    }

    this.setClippingState({
      enabled: true,
      mode: "box",
      boxMin: { x: selBox.min.x, y: selBox.min.y, z: selBox.min.z },
      boxMax: { x: selBox.max.x, y: selBox.max.y, z: selBox.max.z },
    });
    return true;
  }

  /**
   * Resets Section Box bounds to the model's full bounding box.
   */
  resetSectionBox(): void {
    const box = this.getModelBoundingBox();
    if (!box) return;
    this.setClippingState({
      boxMin: { x: box.min.x, y: box.min.y, z: box.min.z },
      boxMax: { x: box.max.x, y: box.max.y, z: box.max.z },
    });
  }

  /**
   * Returns model's full 3D bounding box in world coordinates.
   */
  getModelBoundingBox(): THREE.Box3 | null {
    if (!this.currentModel) return null;
    let box = this.currentModel.box;
    if (!box || !Number.isFinite(box.min.y) || !Number.isFinite(box.max.y) || box.isEmpty()) {
      box = new THREE.Box3().setFromObject(this.currentModel.object);
    }
    if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x) || box.isEmpty()) return null;
    return box.clone();
  }

  /**
   * Returns model min and max extent along a specific axis.
   */
  getModelAxisRange(axis: ClipAxis): { min: number; max: number } | null {
    const box = this.getModelBoundingBox();
    if (!box) return null;
    return { min: box.min[axis], max: box.max[axis] };
  }

  /**
   * Returns model min and max height (Y axis). Preserved for backward compatibility.
   */
  getModelHeightRange(): { min: number; max: number } | null {
    return this.getModelAxisRange("y");
  }

  /** Backward compatibility property getter. */
  private get clipPlane(): THREE.Plane | null {
    return this.activePlanes[0] ?? null;
  }

  debugClippingState(): Readonly<ClippingState> {
    return this.getClippingState();
  }

  getSelection(): Selection | null {
    return this.lastSelection;
  }

  async select(expressId: number | null): Promise<void> {
    if (expressId == null) {
      await this.clearSelection();
      return;
    }
    const model = this.currentModel;
    if (!model) return;
    await this.highlighter.highlightByID(
      "select",
      { [model.modelId]: new Set([expressId]) },
      true,
    );
  }

  async clearSelection(): Promise<void> {
    await this.highlighter.clear("select");
    this.clearSelectionBackEdges();
    this.lastSelection = null;
    this.onSelection.emit(null);
  }

  async fitToSelection(): Promise<void> {
    const model = this.currentModel;
    if (!model) return;
    let box = model.box;
    if (this.lastSelection) {
      box = await model.getMergedBox([this.lastSelection.expressId]);
    }
    const testVec = new THREE.Vector3();
    const size = box.getSize(testVec);
    const len = size.length();
    const center = box.getCenter(new THREE.Vector3());
    if (!Number.isFinite(len) || len <= 0 || box.isEmpty()) return;

    const maxDim = Math.max(size.x, size.y, size.z, 0.1);
    const camera = this.world.camera.three;
    const requiredFar = Math.max(10000, maxDim * 50, center.length() + maxDim * 10);
    const requiredNear = Math.min(0.1, Math.max(0.001, maxDim / 5000));
    if (camera.far < requiredFar) camera.far = requiredFar;
    if (camera.near > requiredNear) camera.near = requiredNear;
    camera.updateProjectionMatrix();

    const controls = this.world.camera.controls;
    controls.maxDistance = Math.max(controls.maxDistance, camera.far * 0.8);
    controls.minDistance = Math.min(controls.minDistance, camera.near * 2);

    const fovRad = THREE.MathUtils.degToRad(
      camera instanceof THREE.PerspectiveCamera ? camera.fov : 60,
    );
    const dist = (maxDim / 2) / Math.tan(fovRad / 2) * 1.5;
    const offset = dist / Math.sqrt(3);

    await controls.setLookAt(
      center.x + offset,
      center.y + offset,
      center.z + offset,
      center.x,
      center.y,
      center.z,
      true,
    );
    controls.update(0.016);
    model.useCamera(camera);
    await this.fragmentsManager.core.update(true);
    this.world.renderer?.update();
  }

  resetCamera(): void {
    if (this.currentModel) {
      void this.zoomToFit(true);
    } else {
      this.world.camera.controls.setLookAt(20, 20, 20, 0, 0, 0, true);
    }
  }
}
