import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import * as FRAGS from "@thatopen/fragments";
import * as THREE from "three";
import { Emitter } from "./events";

export type ElementId = number;

export interface ModelLoaded {
  filename: string;
  elementCount: number;
  categories: ReadonlyMap<string, ElementId[]>;
}

export interface LoadProgress {
  loaded: number;
  total: number;
}

export interface Selection {
  fragmentId: string;
  expressId: ElementId;
}

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
  private fragmentsManager!: OBC.FragmentsManager;
  private classifier!: OBC.Classifier;
  private hider!: OBC.Hider;
  private clipper!: OBC.Clipper;
  private highlighter!: OBF.Highlighter;
  private indexer!: OBC.IfcRelationsIndexer;

  private currentModel: FRAGS.FragmentsGroup | null = null;
  private currentCategories = new Map<string, ElementId[]>();
  private currentFilename = "";
  private lastSelection: Selection | null = null;
  private clipPlane: any = null;

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

    const ifcLoader = components.get(OBC.IfcLoader);
    // Path must end with "/" — web-ifc concatenates `path + "web-ifc.wasm"`.
    // "./" resolves relative to the document, which works for both Vite dev
    // and packaged file:// loads.
    //
    // Memory tuning:
    //  - MEMORY_LIMIT defaults to 2 GiB; pushing past that on wasm32 in
    //    Chromium causes "memory access out of bounds" because wasm growth
    //    fails. Leave it default.
    //  - TAPE_SIZE bumped to 256 MiB so the parser has headroom for big files.
    //  - IFCOPENINGELEMENT excluded — these are the holes for doors/windows,
    //    not visible geometry, but in many IFC files they balloon the
    //    fragment count. Skipping them can ~halve memory use without
    //    affecting what you see.
    const IFCOPENINGELEMENT = 3588315303;
    await ifcLoader.setup({
      autoSetWasm: false,
      wasm: { path: "./", absolute: false },
      excludedCategories: new Set<number>([IFCOPENINGELEMENT]),
      webIfc: {
        COORDINATE_TO_ORIGIN: true,
        TAPE_SIZE: 256 * 1024 * 1024,
      } as any,
    });

    this.fragmentsManager = components.get(OBC.FragmentsManager);
    this.classifier = components.get(OBC.Classifier);
    this.hider = components.get(OBC.Hider);
    this.clipper = components.get(OBC.Clipper);
    this.clipper.enabled = false;
    this.indexer = components.get(OBC.IfcRelationsIndexer);

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

    this.onLoadProgress.emit({
      loaded: buffer.byteLength,
      total: buffer.byteLength,
    });

    this.classifier.byEntity(model);
    const categories = new Map<string, ElementId[]>();
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
    this.currentCategories = categories;

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

    let elementCount = 0;
    for (const ids of categories.values()) elementCount += ids.length;

    this.onModelLoaded.emit({
      filename: name,
      elementCount,
      categories,
    });
  }

  unloadIfc(): void {
    if (!this.currentModel) return;
    this.world.scene.three.remove(this.currentModel);
    try {
      this.fragmentsManager.disposeGroup(this.currentModel);
    } catch {
      /* ignore — older versions may not have disposeGroup */
    }
    this.currentModel = null;
    this.currentCategories.clear();
    this.currentFilename = "";
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

  async getProperties(
    expressId: ElementId,
  ): Promise<Record<string, unknown> | null> {
    if (!this.currentModel) return null;
    const props = await this.currentModel.getProperties(expressId);
    return (props as Record<string, unknown>) ?? null;
  }

  async getPropertySets(
    expressId: ElementId,
  ): Promise<Array<{ name: string; props: Record<string, unknown> }>> {
    if (!this.currentModel) return [];
    try {
      await this.indexer.process(this.currentModel);
    } catch {
      /* ignore — index may already exist */
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
      const box = new THREE.Box3().setFromObject(this.currentModel);
      const size = box.getSize(new THREE.Vector3()).length();
      const center = box.getCenter(new THREE.Vector3());
      this.world.camera.controls.setLookAt(
        center.x + size,
        center.y + size,
        center.z + size,
        center.x,
        center.y,
        center.z,
        true,
      );
    } else {
      this.world.camera.controls.setLookAt(20, 20, 20, 0, 0, 0, true);
    }
  }
}
