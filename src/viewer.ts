import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import * as FRAGS from "@thatopen/fragments";
import * as THREE from "three";
import { Emitter } from "./events";
import { IfcParameterReader, type ElementParameters } from "./ifc-parameters";

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

// Files larger than this go through the streaming pipeline (IfcGeometryTiler
// + IfcStreamer) instead of the in-one-shot IfcLoader. The threshold is
// well below web-ifc's ~2 GiB wasm memory cap, accounting for the fact that
// geometry generation typically uses 10-20× the source IFC size.
const STREAM_THRESHOLD_BYTES = 50 * 1024 * 1024;

export class Viewer {
  readonly onModelLoaded = new Emitter<ModelLoaded>();
  readonly onModelUnloaded = new Emitter<void>();
  readonly onSelection = new Emitter<Selection | null>();
  readonly onLoadProgress = new Emitter<LoadProgress>();

  private components!: OBC.Components;
  private world!: OBC.SimpleWorld<
    OBC.SimpleScene,
    OBC.SimpleCamera,
    OBC.SimpleRenderer
  >;
  private ifcLoader!: OBC.IfcLoader;
  private tiler!: OBC.IfcGeometryTiler;
  private streamer!: OBF.IfcStreamer;
  private fragmentsManager!: OBC.FragmentsManager;
  private classifier!: OBC.Classifier;
  private hider!: OBC.Hider;
  private clipper!: OBC.Clipper;
  private highlighter!: OBF.Highlighter;
  private indexer!: OBC.IfcRelationsIndexer;

  private currentModel: FRAGS.FragmentsGroup | null = null;
  private currentCategories = new Map<string, ElementId[]>();
  private currentFilename = "";
  private currentIsStreamed = false;
  private lastSelection: Selection | null = null;
  private clipPlane: any = null;

  /**
   * Raw-IFC reader kept open alongside the fragments. OBC's IfcLoader strips
   * every geometry-representation entity from the group's property store, so
   * profile dimensions, extrusions and placements are only reachable this way.
   */
  private paramReader: IfcParameterReader | null = null;

  // In-memory tile store for the streaming path. Each load replaces this map.
  private streamFiles = new Map<string, Uint8Array>();

  async init(container: HTMLElement): Promise<void> {
    const components = new OBC.Components();
    const worlds = components.get(OBC.Worlds);
    const world = worlds.create<
      OBC.SimpleScene,
      OBC.SimpleCamera,
      OBC.SimpleRenderer
    >();
    world.scene = new OBC.SimpleScene(components);
    world.renderer = new OBC.SimpleRenderer(components, container);
    world.camera = new OBC.SimpleCamera(components);
    world.scene.setup();
    components.init();

    world.scene.three.background = new THREE.Color("#1a1f26");
    world.camera.controls.setLookAt(20, 20, 20, 0, 0, 0);

    const grids = components.get(OBC.Grids);
    grids.create(world);

    // Shared web-ifc settings used by both the regular loader and the
    // streaming tiler.
    //  - "./" wasm path → resolves next to the document for both vite dev
    //    and packaged file:// loads.
    //  - MEMORY_LIMIT defaults to 2 GiB; pushing past that on wasm32 causes
    //    "memory access out of bounds". Leave it default.
    //  - TAPE_SIZE bumped to 256 MiB.
    //  - IFCOPENINGELEMENT excluded — door/window holes balloon fragment
    //    counts on big files and aren't visible.
    const IFCOPENINGELEMENT = 3588315303;
    const wasmConfig = {
      autoSetWasm: false,
      wasm: { path: "./", absolute: false },
      excludedCategories: new Set<number>([IFCOPENINGELEMENT]),
      webIfc: {
        COORDINATE_TO_ORIGIN: true,
        TAPE_SIZE: 256 * 1024 * 1024,
      },
    };

    const ifcLoader = components.get(OBC.IfcLoader);
    await ifcLoader.setup(wasmConfig as any);

    const tiler = components.get(OBC.IfcGeometryTiler);
    // The tiler exposes the same shape of settings as the loader.
    Object.assign(tiler.settings, {
      autoSetWasm: false,
      wasm: { path: "./", absolute: false },
      excludedCategories: new Set<number>([IFCOPENINGELEMENT]),
      webIfc: {
        COORDINATE_TO_ORIGIN: true,
        TAPE_SIZE: 256 * 1024 * 1024,
      },
    });

    this.fragmentsManager = components.get(OBC.FragmentsManager);
    this.classifier = components.get(OBC.Classifier);
    this.hider = components.get(OBC.Hider);
    this.clipper = components.get(OBC.Clipper);
    this.clipper.enabled = false;
    this.indexer = components.get(OBC.IfcRelationsIndexer);

    const streamer = components.get(OBF.IfcStreamer);
    streamer.world = world;
    streamer.url = ""; // overridden by our custom fetch below
    // Resolve tile filenames against our in-memory map. The streamer expects
    // a function that returns Response | File; a Response built from the
    // Uint8Array is the simplest fit.
    streamer.fetch = async (fileName: string) => {
      const data = this.streamFiles.get(fileName);
      if (!data) {
        throw new Error(`stream tile not found: ${fileName}`);
      }
      // Cast through unknown — TS3 typings of Response don't accept
      // Uint8Array<ArrayBufferLike> directly, but Chromium handles it fine.
      return new Response(data as unknown as BlobPart as any);
    };

    const highlighter = components.get(OBF.Highlighter);
    highlighter.setup({
      world,
      selectionColor: new THREE.Color("#f0883e"),
    });
    highlighter.zoomToSelection = false;
    if (highlighter.colors instanceof Map) {
      highlighter.colors.set("select", new THREE.Color("#f0883e"));
    }

    const selectEvents = highlighter.events["select"];
    if (selectEvents) {
      selectEvents.onHighlight.add((fragmentIdMap) => {
        const fragId = Object.keys(fragmentIdMap)[0];
        if (!fragId) return;
        const ids = fragmentIdMap[fragId];
        const expressId = ids?.values().next().value as number | undefined;
        if (expressId === undefined) return;
        this.lastSelection = { fragmentId: fragId, expressId };
        this.onSelection.emit(this.lastSelection);
      });
      selectEvents.onClear.add(() => {
        this.lastSelection = null;
        this.onSelection.emit(null);
      });
    }

    this.components = components;
    this.world = world;
    this.ifcLoader = ifcLoader;
    this.tiler = tiler;
    this.streamer = streamer;
    this.highlighter = highlighter;
  }

  async loadIfc(input: File | ArrayBuffer, filename?: string): Promise<void> {
    const name =
      filename ?? (input instanceof File ? input.name : "model.ifc");
    const buffer =
      input instanceof File
        ? new Uint8Array(await input.arrayBuffer())
        : new Uint8Array(input);

    this.onLoadProgress.emit({ loaded: 0, total: buffer.byteLength });

    if (buffer.byteLength > STREAM_THRESHOLD_BYTES) {
      await this.loadIfcStreaming(buffer, name);
    } else {
      await this.loadIfcRegular(buffer, name);
    }
  }

  private async loadIfcRegular(
    buffer: Uint8Array,
    name: string,
  ): Promise<void> {
    let model: FRAGS.FragmentsGroup;
    try {
      model = await this.ifcLoader.load(buffer, true, name);
    } catch (err) {
      this.onLoadProgress.emit({
        loaded: buffer.byteLength,
        total: buffer.byteLength,
      });
      throw new Error(`IFC parse failed: ${(err as Error).message}`);
    }

    if (this.currentModel) this.unloadIfc();

    this.world.scene.three.add(model);
    this.currentModel = model;
    this.currentFilename = name;
    this.currentIsStreamed = false;

    this.onLoadProgress.emit({
      loaded: buffer.byteLength,
      total: buffer.byteLength,
    });

    await this.openParameterReader(buffer);
    this.classifyAndEmit(model, name, false);
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

  private async loadIfcStreaming(
    buffer: Uint8Array,
    name: string,
  ): Promise<void> {
    // Tile the IFC. The tiler emits geometry chunks and assets via async
    // events while it processes — it does NOT hold the whole result in
    // memory the way IfcLoader does, which is why this works for files
    // that crash the regular loader.
    const tileFiles = new Map<string, Uint8Array>();
    const assets: OBC.StreamedAsset[] = [];
    const geometries: OBC.StreamedGeometries = {};
    let geomFileIdx = 0;

    const offGeom = this.tiler.onGeometryStreamed.add(
      async ({ buffer: tileBuffer, data }) => {
        const fileName = `geom-${geomFileIdx++}.frag`;
        tileFiles.set(fileName, tileBuffer);
        for (const [idStr, geom] of Object.entries(data)) {
          (geometries as any)[Number(idStr)] = {
            ...geom,
            geometryFile: fileName,
          };
        }
      },
    );
    const offAssets = this.tiler.onAssetStreamed.add(async (a) => {
      assets.push(...a);
    });
    const offProgress = this.tiler.onProgress.add(async (pct) => {
      // Map 0..1 → 0..byteLength so the existing progress UI works.
      this.onLoadProgress.emit({
        loaded: Math.floor(pct * buffer.byteLength),
        total: buffer.byteLength,
      });
    });

    try {
      await this.tiler.streamFromBuffer(buffer);
    } catch (err) {
      throw new Error(`IFC tile failed: ${(err as Error).message}`);
    } finally {
      // Detach our event handlers so a future load doesn't double up.
      try {
        this.tiler.onGeometryStreamed.remove(offGeom as any);
      } catch {
        /* ignore */
      }
      try {
        this.tiler.onAssetStreamed.remove(offAssets as any);
      } catch {
        /* ignore */
      }
      try {
        this.tiler.onProgress.remove(offProgress as any);
      } catch {
        /* ignore */
      }
    }

    if (this.currentModel) this.unloadIfc();

    // Hand the tiles to the streamer via our in-memory file map.
    this.streamFiles = tileFiles;

    const settings = {
      assets,
      geometries,
      globalDataFileId: name,
    } as any;

    let model: FRAGS.FragmentsGroup;
    try {
      model = await this.streamer.load(settings, true);
    } catch (err) {
      this.streamFiles.clear();
      throw new Error(`Stream-load failed: ${(err as Error).message}`);
    }

    this.currentModel = model;
    this.currentFilename = name;
    this.currentIsStreamed = true;

    this.onLoadProgress.emit({
      loaded: buffer.byteLength,
      total: buffer.byteLength,
    });

    this.classifyAndEmit(model, name, true);
    this.fitToModel(model);
  }

  private classifyAndEmit(
    model: FRAGS.FragmentsGroup,
    name: string,
    streamed: boolean,
  ): void {
    let categories = new Map<string, ElementId[]>();
    try {
      this.classifier.byEntity(model);
      const entities = this.classifier.list["entities"] ?? {};
      for (const [ifcClass, group] of Object.entries(entities)) {
        const ids: ElementId[] = [];
        const map = (group as any).map ?? {};
        for (const fragId of Object.keys(map)) {
          for (const expressId of map[fragId] as Iterable<number>) {
            ids.push(expressId);
          }
        }
        categories.set(ifcClass, ids);
      }
    } catch {
      // For streamed models without properties, classification by entity
      // may be limited. Leave the map empty in that case.
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

  private fitToModel(model: FRAGS.FragmentsGroup): void {
    const box = new THREE.Box3().setFromObject(model);
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
        true,
      );
    }
  }

  unloadIfc(): void {
    if (!this.currentModel) return;
    this.world.scene.three.remove(this.currentModel);
    try {
      this.fragmentsManager.disposeGroup(this.currentModel);
    } catch {
      /* ignore */
    }
    this.paramReader?.close();
    this.paramReader = null;
    this.streamFiles.clear();
    this.currentModel = null;
    this.currentCategories.clear();
    this.currentFilename = "";
    this.currentIsStreamed = false;
    this.lastSelection = null;
    this.clipper.deleteAll();
    this.clipPlane = null;
    this.clipper.enabled = false;
    this.onModelUnloaded.emit();
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

  setCategoryVisible(ifcClass: string, visible: boolean): void {
    if (!this.currentModel) return;
    const found = this.classifier.find({ entities: [ifcClass] });
    if (Object.keys(found).length === 0) return;
    this.hider.set(visible, found);
  }

  isolateCategory(ifcClass: string): void {
    for (const c of this.currentCategories.keys()) {
      this.setCategoryVisible(c, c === ifcClass);
    }
  }

  showAllCategories(): void {
    for (const c of this.currentCategories.keys()) {
      this.setCategoryVisible(c, true);
    }
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
    if (!this.currentModel) return null;
    if (this.currentIsStreamed) return null; // properties not tiled in v1
    const props = await this.currentModel.getProperties(expressId);
    return (props as Record<string, unknown>) ?? null;
  }

  async getPropertySets(
    expressId: ElementId,
  ): Promise<Array<{ name: string; props: Record<string, unknown> }>> {
    if (!this.currentModel) return [];
    if (this.currentIsStreamed) return [];
    try {
      await this.indexer.process(this.currentModel);
    } catch {
      /* ignore */
    }
    let psetIds: number[] = [];
    try {
      psetIds =
        this.indexer.getEntityRelations(
          this.currentModel,
          expressId,
          "IsDefinedBy",
        ) ?? [];
    } catch {
      psetIds = [];
    }
    const out: Array<{ name: string; props: Record<string, unknown> }> = [];
    for (const id of psetIds) {
      const pset = (await this.currentModel.getProperties(id)) as any;
      if (!pset) continue;
      const psetName = pset.Name?.value ?? `Pset_${id}`;
      const props: Record<string, unknown> = {};
      const hasProps = pset.HasProperties;
      if (Array.isArray(hasProps)) {
        for (const ref of hasProps) {
          const refId = ref?.value;
          if (typeof refId !== "number") continue;
          const single = (await this.currentModel.getProperties(refId)) as any;
          if (single?.Name?.value !== undefined) {
            props[String(single.Name.value)] =
              single.NominalValue?.value ?? null;
          }
        }
      }
      out.push({ name: String(psetName), props });
    }
    return out;
  }

  setClippingPlane(enabled: boolean, height = 0): void {
    if (!enabled) {
      this.clipper.deleteAll();
      this.clipPlane = null;
      this.clipper.enabled = false;
      return;
    }
    this.clipper.enabled = true;
    if (!this.clipPlane) {
      const normal = new THREE.Vector3(0, 1, 0);
      const point = new THREE.Vector3(0, height, 0);
      this.clipPlane = this.clipper.createFromNormalAndCoplanarPoint(
        this.world,
        normal,
        point,
      );
    } else {
      const three = this.clipPlane.three ?? this.clipPlane;
      if (three && typeof three.constant === "number") {
        three.constant = -height;
      }
    }
  }

  getModelHeightRange(): { min: number; max: number } | null {
    if (!this.currentModel) return null;
    const box = new THREE.Box3().setFromObject(this.currentModel);
    if (!Number.isFinite(box.min.y) || !Number.isFinite(box.max.y)) return null;
    return { min: box.min.y, max: box.max.y };
  }

  async fitToSelection(): Promise<void> {
    if (!this.currentModel) return;
    const box = new THREE.Box3();
    if (this.lastSelection) {
      const fragment = this.fragmentsManager.list.get(
        this.lastSelection.fragmentId,
      );
      const mesh = (fragment as any)?.mesh;
      if (mesh) {
        box.setFromObject(mesh);
      } else {
        box.setFromObject(this.currentModel);
      }
    } else {
      box.setFromObject(this.currentModel);
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
