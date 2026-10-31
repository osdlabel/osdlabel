/**
 * A document exactly as osdlabel 0.21.0 exported it, a release before
 * `deserialize` checked that an annotation's Fabric payload is the kind of
 * object its geometry describes. Every document a release has written must
 * still load.
 *
 * It was produced with osdlabel@0.21.0 and fabric@7.4.0 installed from npm,
 * not with this checkout: `createAnnotationFromGeometry` for one annotation of
 * each geometry type (`polygon` under the freehand tool, as that tool records
 * a closed path), and `processToolAddAnnotation` for what that release's
 * polyline tool commits when the path is closed (a `Polygon` under
 * `toolType: 'polyline'`) and its freehand tool for an open path (a
 * `Polyline` under `toolType: 'freeHandPath'`). Ids and timestamps were fixed
 * so the text is stable. The rectangles are as that release saved them,
 * `left`/`top` at the geometry's origin under a centre origin (see
 * `legacy-rectangle.test.ts`).
 *
 * The text below is `JSON.stringify(doc, null, 2)`, which is what the dev
 * app's Export JSON panel shows, kept verbatim rather than as a literal so
 * formatting cannot change it.
 */
export const DOCUMENT_0_21_0_JSON = `[
  {
    "id": "rect-1",
    "geometry": {
      "type": "rectangle",
      "origin": {
        "x": 100,
        "y": 80
      },
      "width": 120,
      "height": 60,
      "rotation": 0
    },
    "toolType": "rectangle",
    "imageId": "sample-1",
    "contextId": "general",
    "rawAnnotationData": {
      "format": "fabric",
      "fabricVersion": "7.4.0",
      "data": {
        "rx": 0,
        "ry": 0,
        "id": "rect-1",
        "type": "Rect",
        "version": "7.4.0",
        "originX": "center",
        "originY": "center",
        "left": 100,
        "top": 80,
        "width": 120,
        "height": 60,
        "fill": "rgba(255,0,0,0.1)",
        "stroke": "#ff0000",
        "strokeWidth": 2,
        "strokeDashArray": null,
        "strokeLineCap": "butt",
        "strokeDashOffset": 0,
        "strokeLineJoin": "miter",
        "strokeUniform": true,
        "strokeMiterLimit": 4,
        "scaleX": 1,
        "scaleY": 1,
        "angle": 0,
        "flipX": false,
        "flipY": false,
        "opacity": 1,
        "shadow": null,
        "visible": true,
        "backgroundColor": "",
        "fillRule": "nonzero",
        "paintFirst": "fill",
        "globalCompositeOperation": "source-over",
        "skewX": 0,
        "skewY": 0
      }
    },
    "createdAt": "2026-10-01T12:00:00.000Z",
    "updatedAt": "2026-10-01T12:00:00.000Z"
  },
  {
    "id": "rect-2",
    "geometry": {
      "type": "rectangle",
      "origin": {
        "x": 400,
        "y": 300
      },
      "width": 90,
      "height": 40,
      "rotation": 30
    },
    "toolType": "rectangle",
    "imageId": "sample-1",
    "contextId": "general",
    "rawAnnotationData": {
      "format": "fabric",
      "fabricVersion": "7.4.0",
      "data": {
        "rx": 0,
        "ry": 0,
        "id": "rect-2",
        "type": "Rect",
        "version": "7.4.0",
        "originX": "center",
        "originY": "center",
        "left": 400,
        "top": 300,
        "width": 90,
        "height": 40,
        "fill": "rgba(255,0,0,0.1)",
        "stroke": "#ff0000",
        "strokeWidth": 2,
        "strokeDashArray": null,
        "strokeLineCap": "butt",
        "strokeDashOffset": 0,
        "strokeLineJoin": "miter",
        "strokeUniform": true,
        "strokeMiterLimit": 4,
        "scaleX": 1,
        "scaleY": 1,
        "angle": 30,
        "flipX": false,
        "flipY": false,
        "opacity": 1,
        "shadow": null,
        "visible": true,
        "backgroundColor": "",
        "fillRule": "nonzero",
        "paintFirst": "fill",
        "globalCompositeOperation": "source-over",
        "skewX": 0,
        "skewY": 0
      }
    },
    "createdAt": "2026-10-01T12:00:00.000Z",
    "updatedAt": "2026-10-01T12:00:00.000Z"
  },
  {
    "id": "circle-1",
    "geometry": {
      "type": "circle",
      "center": {
        "x": 300,
        "y": 200
      },
      "radius": 45
    },
    "toolType": "circle",
    "imageId": "sample-1",
    "contextId": "general",
    "rawAnnotationData": {
      "format": "fabric",
      "fabricVersion": "7.4.0",
      "data": {
        "radius": 45,
        "startAngle": 0,
        "endAngle": 360,
        "counterClockwise": false,
        "id": "circle-1",
        "type": "Circle",
        "version": "7.4.0",
        "originX": "center",
        "originY": "center",
        "left": 300,
        "top": 200,
        "width": 90,
        "height": 90,
        "fill": "rgba(255,0,0,0.1)",
        "stroke": "#ff0000",
        "strokeWidth": 2,
        "strokeDashArray": null,
        "strokeLineCap": "butt",
        "strokeDashOffset": 0,
        "strokeLineJoin": "miter",
        "strokeUniform": true,
        "strokeMiterLimit": 4,
        "scaleX": 1,
        "scaleY": 1,
        "angle": 0,
        "flipX": false,
        "flipY": false,
        "opacity": 1,
        "shadow": null,
        "visible": true,
        "backgroundColor": "",
        "fillRule": "nonzero",
        "paintFirst": "fill",
        "globalCompositeOperation": "source-over",
        "skewX": 0,
        "skewY": 0
      }
    },
    "createdAt": "2026-10-01T12:00:00.000Z",
    "updatedAt": "2026-10-01T12:00:00.000Z"
  },
  {
    "id": "line-1",
    "geometry": {
      "type": "line",
      "start": {
        "x": 50,
        "y": 400
      },
      "end": {
        "x": 250,
        "y": 450
      }
    },
    "toolType": "line",
    "imageId": "sample-1",
    "contextId": "general",
    "rawAnnotationData": {
      "format": "fabric",
      "fabricVersion": "7.4.0",
      "data": {
        "id": "line-1",
        "type": "Line",
        "version": "7.4.0",
        "originX": "left",
        "originY": "top",
        "left": 49,
        "top": 399,
        "width": 200,
        "height": 50,
        "fill": "rgba(255,0,0,0.1)",
        "stroke": "#ff0000",
        "strokeWidth": 2,
        "strokeDashArray": null,
        "strokeLineCap": "butt",
        "strokeDashOffset": 0,
        "strokeLineJoin": "miter",
        "strokeUniform": true,
        "strokeMiterLimit": 4,
        "scaleX": 1,
        "scaleY": 1,
        "angle": 0,
        "flipX": false,
        "flipY": false,
        "opacity": 1,
        "shadow": null,
        "visible": true,
        "backgroundColor": "",
        "fillRule": "nonzero",
        "paintFirst": "fill",
        "globalCompositeOperation": "source-over",
        "skewX": 0,
        "skewY": 0,
        "x1": -100,
        "x2": 100,
        "y1": -25,
        "y2": 25
      }
    },
    "createdAt": "2026-10-01T12:00:00.000Z",
    "updatedAt": "2026-10-01T12:00:00.000Z"
  },
  {
    "id": "point-1",
    "geometry": {
      "type": "point",
      "position": {
        "x": 600,
        "y": 120
      }
    },
    "toolType": "point",
    "imageId": "sample-1",
    "contextId": "general",
    "rawAnnotationData": {
      "format": "fabric",
      "fabricVersion": "7.4.0",
      "data": {
        "radius": 5,
        "startAngle": 0,
        "endAngle": 360,
        "counterClockwise": false,
        "id": "point-1",
        "type": "Circle",
        "version": "7.4.0",
        "originX": "center",
        "originY": "center",
        "left": 600,
        "top": 120,
        "width": 10,
        "height": 10,
        "fill": "rgba(255,0,0,0.1)",
        "stroke": "#ff0000",
        "strokeWidth": 2,
        "strokeDashArray": null,
        "strokeLineCap": "butt",
        "strokeDashOffset": 0,
        "strokeLineJoin": "miter",
        "strokeUniform": true,
        "strokeMiterLimit": 4,
        "scaleX": 1,
        "scaleY": 1,
        "angle": 0,
        "flipX": false,
        "flipY": false,
        "opacity": 1,
        "shadow": null,
        "visible": true,
        "backgroundColor": "",
        "fillRule": "nonzero",
        "paintFirst": "fill",
        "globalCompositeOperation": "source-over",
        "skewX": 0,
        "skewY": 0
      }
    },
    "createdAt": "2026-10-01T12:00:00.000Z",
    "updatedAt": "2026-10-01T12:00:00.000Z"
  },
  {
    "id": "polyline-1",
    "geometry": {
      "type": "polyline",
      "points": [
        {
          "x": 700,
          "y": 400
        },
        {
          "x": 760,
          "y": 430
        },
        {
          "x": 820,
          "y": 410
        }
      ]
    },
    "toolType": "polyline",
    "imageId": "sample-1",
    "contextId": "general",
    "rawAnnotationData": {
      "format": "fabric",
      "fabricVersion": "7.4.0",
      "data": {
        "id": "polyline-1",
        "type": "Polyline",
        "version": "7.4.0",
        "originX": "center",
        "originY": "center",
        "left": 760,
        "top": 415,
        "width": 120,
        "height": 30,
        "fill": "transparent",
        "stroke": "#ff0000",
        "strokeWidth": 2,
        "strokeDashArray": null,
        "strokeLineCap": "butt",
        "strokeDashOffset": 0,
        "strokeLineJoin": "miter",
        "strokeUniform": true,
        "strokeMiterLimit": 4,
        "scaleX": 1,
        "scaleY": 1,
        "angle": 0,
        "flipX": false,
        "flipY": false,
        "opacity": 1,
        "shadow": null,
        "visible": true,
        "backgroundColor": "",
        "fillRule": "nonzero",
        "paintFirst": "fill",
        "globalCompositeOperation": "source-over",
        "skewX": 0,
        "skewY": 0,
        "points": [
          {
            "x": 700,
            "y": 400
          },
          {
            "x": 760,
            "y": 430
          },
          {
            "x": 820,
            "y": 410
          }
        ]
      }
    },
    "createdAt": "2026-10-01T12:00:00.000Z",
    "updatedAt": "2026-10-01T12:00:00.000Z"
  },
  {
    "id": "polygon-1",
    "geometry": {
      "type": "polygon",
      "points": [
        {
          "x": 500,
          "y": 500
        },
        {
          "x": 580,
          "y": 520
        },
        {
          "x": 540,
          "y": 590
        }
      ]
    },
    "toolType": "freeHandPath",
    "imageId": "sample-1",
    "contextId": "general",
    "rawAnnotationData": {
      "format": "fabric",
      "fabricVersion": "7.4.0",
      "data": {
        "id": "polygon-1",
        "type": "Polygon",
        "version": "7.4.0",
        "originX": "center",
        "originY": "center",
        "left": 540,
        "top": 545,
        "width": 80,
        "height": 90,
        "fill": "rgba(255,0,0,0.1)",
        "stroke": "#ff0000",
        "strokeWidth": 2,
        "strokeDashArray": null,
        "strokeLineCap": "butt",
        "strokeDashOffset": 0,
        "strokeLineJoin": "miter",
        "strokeUniform": true,
        "strokeMiterLimit": 4,
        "scaleX": 1,
        "scaleY": 1,
        "angle": 0,
        "flipX": false,
        "flipY": false,
        "opacity": 1,
        "shadow": null,
        "visible": true,
        "backgroundColor": "",
        "fillRule": "nonzero",
        "paintFirst": "fill",
        "globalCompositeOperation": "source-over",
        "skewX": 0,
        "skewY": 0,
        "points": [
          {
            "x": 500,
            "y": 500
          },
          {
            "x": 580,
            "y": 520
          },
          {
            "x": 540,
            "y": 590
          }
        ]
      }
    },
    "createdAt": "2026-10-01T12:00:00.000Z",
    "updatedAt": "2026-10-01T12:00:00.000Z"
  },
  {
    "id": "closed-polyline-1",
    "geometry": {
      "type": "polygon",
      "points": [
        {
          "x": 900,
          "y": 100
        },
        {
          "x": 960,
          "y": 140
        },
        {
          "x": 910,
          "y": 180
        }
      ]
    },
    "toolType": "polyline",
    "imageId": "sample-1",
    "contextId": "general",
    "rawAnnotationData": {
      "format": "fabric",
      "fabricVersion": "7.4.0",
      "data": {
        "id": "closed-polyline-1",
        "type": "Polygon",
        "version": "7.4.0",
        "originX": "center",
        "originY": "center",
        "left": 930,
        "top": 140,
        "width": 60,
        "height": 80,
        "fill": "rgba(255,0,0,0.1)",
        "stroke": "#ff0000",
        "strokeWidth": 2,
        "strokeDashArray": null,
        "strokeLineCap": "butt",
        "strokeDashOffset": 0,
        "strokeLineJoin": "miter",
        "strokeUniform": true,
        "strokeMiterLimit": 4,
        "scaleX": 1,
        "scaleY": 1,
        "angle": 0,
        "flipX": false,
        "flipY": false,
        "opacity": 1,
        "shadow": null,
        "visible": true,
        "backgroundColor": "",
        "fillRule": "nonzero",
        "paintFirst": "fill",
        "globalCompositeOperation": "source-over",
        "skewX": 0,
        "skewY": 0,
        "points": [
          {
            "x": 900,
            "y": 100
          },
          {
            "x": 960,
            "y": 140
          },
          {
            "x": 910,
            "y": 180
          }
        ]
      }
    },
    "createdAt": "2026-10-01T12:00:00.000Z",
    "updatedAt": "2026-10-01T12:00:00.000Z"
  },
  {
    "id": "open-freehand-1",
    "geometry": {
      "type": "polyline",
      "points": [
        {
          "x": 900,
          "y": 300
        },
        {
          "x": 930,
          "y": 320
        },
        {
          "x": 970,
          "y": 310
        }
      ]
    },
    "toolType": "freeHandPath",
    "imageId": "sample-1",
    "contextId": "general",
    "rawAnnotationData": {
      "format": "fabric",
      "fabricVersion": "7.4.0",
      "data": {
        "id": "open-freehand-1",
        "type": "Polyline",
        "version": "7.4.0",
        "originX": "center",
        "originY": "center",
        "left": 935,
        "top": 310,
        "width": 70,
        "height": 20,
        "fill": "transparent",
        "stroke": "#ff0000",
        "strokeWidth": 2,
        "strokeDashArray": null,
        "strokeLineCap": "butt",
        "strokeDashOffset": 0,
        "strokeLineJoin": "miter",
        "strokeUniform": true,
        "strokeMiterLimit": 4,
        "scaleX": 1,
        "scaleY": 1,
        "angle": 0,
        "flipX": false,
        "flipY": false,
        "opacity": 1,
        "shadow": null,
        "visible": true,
        "backgroundColor": "",
        "fillRule": "nonzero",
        "paintFirst": "fill",
        "globalCompositeOperation": "source-over",
        "skewX": 0,
        "skewY": 0,
        "points": [
          {
            "x": 900,
            "y": 300
          },
          {
            "x": 930,
            "y": 320
          },
          {
            "x": 970,
            "y": 310
          }
        ]
      }
    },
    "createdAt": "2026-10-01T12:00:00.000Z",
    "updatedAt": "2026-10-01T12:00:00.000Z"
  }
]`;
