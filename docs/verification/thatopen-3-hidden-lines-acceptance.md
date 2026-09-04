# That Open 3.x Upgrade & Hidden-Line (PEN) Acceptance Verification

- **Date:** 2026-09-04
- **Branch:** `feat/thatopen-3-hidden-lines`
- **Environment:** Linux aarch64 (Debian GNU/Linux 12 bookworm, Raspberry Pi 4)
- **Packaged Application:** `release/linux-arm64-unpacked/ifc-viewer`

## 1. Runtime & Dependency Versions

| Component | Version |
|---|---|
| `@thatopen/components` | `3.4.8` |
| `@thatopen/components-front` | `3.4.4` |
| `@thatopen/fragments` | `3.4.7` |
| `web-ifc` | `0.0.77` |
| `three` | `^0.182.0` |
| `electron` | `31.7.7` |
| `playwright` | `1.45.0` |

## 2. Preprocessing Acceptance: Real Model (> 50 MiB)

The acceptance test uses a 54.5 MB IFC fixture (`/tmp/large-entities.ifc`) with thousands of structural elements, exceeding the 50 MiB streaming preprocessing threshold.

- **File Path:** `/tmp/large-entities.ifc`
- **File Size:** `54,525,983` bytes (52.00 MiB)

### Cache Miss (First Load)
The file is routed to the background Electron utility process converter:
- **Duration:** 18,305 ms (~18.3 s)
- **Cache Hit:** `false`
- **Cache ID:** `ec5fe9d3c66dd5fb430e773a03fa1c6b6ab28275fd3815f25a9c836c37ee7526`
- **Streamed Flag:** `true`
- **Category Groups Extracted:** 10

### Cache Hit (Second Load)
The cached `.frag` file is immediately loaded directly into memory without re-running the IFC conversion worker:
- **Duration:** 952 ms (~0.95 s)
- **Cache Hit:** `true`
- **Cache ID:** `ec5fe9d3c66dd5fb430e773a03fa1c6b6ab28275fd3815f25a9c836c37ee7526`
- **Performance Improvement:** > 19× faster load time

## 3. Visual Verification: Postproduction Styles

All four render styles were verified at an identical camera position (`(5, 5, 5)` looking at `(0, 0, 0)`):

### 1. Normal Mode (`COLOR`)
- Standard shaded fragment rendering without edge outlines.
- Screenshot: [normal.png](normal.png)

### 2. Edges Mode (`COLOR_PEN`)
- Shaded fragments with crisp silhouette and feature line outlines.
- Screenshot: [edges.png](edges.png)

### 3. Hidden-Line Mode (`PEN`)
- Pure black-and-white architectural line drawing mode.
- Opaque white faces, crisp black edges, black grid on white background.
- **Visual Check:** Hidden lines behind opaque surfaces are completely occluded (not visible through faces).
- Screenshot: [pen.png](pen.png)

### 4. Clipped Hidden-Line Mode (`PEN` with Clipping Plane)
- Horizontal clipping plane active at midpoint height.
- Clean section cut revealing interior profile geometry.
- **Visual Check:** No black edge-on gloss slab artifact; section edges are cleanly drawn.
- Screenshot: [clipped-pen.png](clipped-pen.png)

## 4. Acceptance Test Command Output

```json
{
  "modelSize": 54525983,
  "load1TimeMs": 18305,
  "cacheHit1": false,
  "load2TimeMs": 952,
  "cacheHit2": true,
  "streamed": true,
  "categoriesCount": 10
}
```
All styles and edge conditions verified with zero regressions.
