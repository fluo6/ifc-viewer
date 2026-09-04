import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import * as FRAGS from "@thatopen/fragments";
import fragmentsWorkerUrl from "@thatopen/fragments/worker?url";
import * as THREE from "three";
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
  readonly onMeasureModeChanged = new Emitter<boolean>();
  readonly onMeasureSnapChanged = new Emitter<boolean>();

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
  private clipPlane: THREE.Plane | null = null;

  /**
   * Raw-IFC reader kept open alongside the fragments. OBC's IfcLoader strips
   * every geometry-representation entity from the group's property store, so
   * profile dimensions, extrusions and placements are only reachable this way.
   */
  private paramReader: IfcParameterReader | null = null;
  private initialized = false;
  private edgesPreference = false;
  private hiddenLines = false;

  private applyRenderStyle(): void {
    this.ppRenderer.postproduction.style = this.hiddenLines
      ? OBF.PostproductionAspect.PEN
      : this.edgesPreference
        ? OBF.PostproductionAspect.COLOR_PEN
        : OBF.PostproductionAspect.COLOR;
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
    grids.create(world);

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
      void fragmentsManager.core.update(true);
    });

    const ifcLoader = components.get(OBC.IfcLoader);
    await ifcLoader.setup(wasmConfig);

    const highlighter = components.get(OBF.Highlighter);
    highlighter.setup({
      world,
      selectMaterialDefinition: {
        color: new THREE.Color("#f0883e"),
        renderedFaces: FRAGS.RenderedFaces.ONE,
        opacity: 1,
        transparent: false,
        preserveOriginalMaterial: true,
      },
    });
    highlighter.zoomToSelection = false;

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
      });
      selectEvents.onClear.add(() => {
        this.lastSelection = null;
        this.onSelection.emit(null);
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
      fragmentBuffer = await window.electron.readPreparedIfc(prepared.cacheId);
    } finally {
      unsubscribe?.();
    }

    const modelId = `${filename}-${crypto.randomUUID()}`;
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
    this.fitToModel(newModel);
  }

  async loadIfc(input: File | ArrayBuffer, filename?: string): Promise<void> {
    const name =
      filename ?? (input instanceof File ? input.name : "model.ifc");
    const buffer =
      input instanceof File
        ? new Uint8Array(await input.arrayBuffer())
        : new Uint8Array(input);

    this.onLoadProgress.emit({ loaded: 0, total: buffer.byteLength });
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
        `${name}-${crypto.randomUUID()}`,
        {
          instanceCallback: (importer) => {
            importer.classes.elements.delete(IFCOPENINGELEMENT);
          },
        },
      );
    } catch (err) {
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
    this.fitToModel(model);
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

    this.onModelLoaded.emit({
      filename: name,
      elementCount,
      categories,
      streamed,
    });
  }

  private fitToModel(model: FRAGS.FragmentsModel): void {
    const box = model.box;
    const size = box.getSize(new THREE.Vector3()).length();
    const center = box.getCenter(new THREE.Vector3());
    if (Number.isFinite(size) && size > 0) {
      this.world.camera.controls.setLookAt(
        center.x + size,
        center.y + size,
        center.z + size,
        center.x,
        center.y,
        center.z,
        false,
      );
      this.world.camera.controls.update(0.016);
    }
  }

  unloadIfc(): Promise<void> {
    if (!this.currentModel) return Promise.resolve();
    const model = this.currentModel;
    this.setMeasureMode(false);
    this.clearMeasurements();
    this.world.scene.three.remove(model.object);
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
    const renderer = this.world.renderer;
    if (!renderer) return;

    if (!enabled) {
      if (this.clipPlane) renderer.setPlane(false, this.clipPlane);
      this.clipPlane = null;
      return;
    }

    if (this.clipPlane) {
      // For normal (0,-1,0) the plane is -y + constant = 0, so a cut at
      // `height` is constant = height.
      this.clipPlane.constant = height;
      return;
    }
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), height);
    renderer.setPlane(true, this.clipPlane);
  }

  getModelHeightRange(): { min: number; max: number } | null {
    if (!this.currentModel) return null;
    const box = this.currentModel.box;
    if (!Number.isFinite(box.min.y) || !Number.isFinite(box.max.y)) return null;
    return { min: box.min.y, max: box.max.y };
  }

  async fitToSelection(): Promise<void> {
    const model = this.currentModel;
    if (!model) return;
    let box = model.box;
    if (this.lastSelection) {
      box = await model.getMergedBox([this.lastSelection.expressId]);
    }
    const size = box.getSize(new THREE.Vector3()).length();
    const center = box.getCenter(new THREE.Vector3());
    if (!Number.isFinite(size) || size <= 0) return;
    this.world.camera.controls.setLookAt(
      center.x + size,
      center.y + size,
      center.z + size,
      center.x,
      center.y,
      center.z,
      true,
    );
  }

  resetCamera(): void {
    if (this.currentModel) {
      this.fitToModel(this.currentModel);
    } else {
      this.world.camera.controls.setLookAt(20, 20, 20, 0, 0, 0, true);
    }
  }
}
