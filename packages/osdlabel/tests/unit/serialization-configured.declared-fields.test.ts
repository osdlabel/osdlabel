/**
 * `deserialize` checks what each annotation declares — its geometry type, its
 * `toolType` and its payload — against itself before it decodes any mask.
 *
 * Decoding replaces a mask entry's geometry with one read off its pixels. When
 * the checks ran only after that, they never saw what the entry declared:
 * rectangle geometry over a mask payload was reported as a mask, or, recorded
 * under the brush, loaded as one without a word. And a document refused for a
 * wrong `toolType` first decoded every mask in it, up to the budget.
 *
 * So these pin three things: a declared mismatch is refused in the words the
 * full schema uses, naming what was declared; no mask is decoded when it is,
 * which makes the refusal win over a skipped mask and over a blown budget;
 * and every document that loaded before still loads.
 */
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  BoundedDenseMaskBuffer,
  cocoRleCodec,
  createMaskCodecRegistry,
  stampCircle,
  type CocoRleSegmentation,
  type MaskCodec,
} from '@osdlabel/mask';
import { createImageId, type AnnotationState } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { createAnnotationId, type VectorGeometry } from '@osdlabel/annotation';
import { initFabricModule } from '@osdlabel/fabric-annotations';
import { OsdAnnotationSchema } from '@osdlabel/validation';
import { createAnnotationFromGeometry } from '../../src/create-annotation.js';
import { createMaskAnnotation } from '../../src/create-mask-annotation.js';
import {
  deserialize,
  serialize,
  SerializationError,
  type DeserializeOptions,
} from '../../src/serialization-configured.js';
import type { OsdAnnotation, OsdFields } from '../../src/types.js';

initFabricModule();

const imageId = createImageId('img-1');
const contextId = createAnnotationContextId('ctx-1');

/** A painted disc of radius 10 with a hole, on a 400x300 image. */
function mask(id: string): OsdAnnotation {
  const buffer = new BoundedDenseMaskBuffer({ imageWidth: 400, imageHeight: 300 });
  stampCircle(buffer, 120.5, 90.5, 10, 1);
  stampCircle(buffer, 124.5, 92.5, 3, 0);
  return createMaskAnnotation(buffer.snapshot(), {
    imageId,
    contextId,
    id: createAnnotationId(id),
  });
}

function vector(id: string, geometry: VectorGeometry): OsdAnnotation {
  return createAnnotationFromGeometry(geometry, {
    imageId,
    contextId,
    toolType: geometry.type === 'polygon' ? 'freeHandPath' : geometry.type,
    id: createAnnotationId(id),
  });
}

const rectangle = (id: string): OsdAnnotation =>
  vector(id, { type: 'rectangle', origin: { x: 5, y: 5 }, width: 20, height: 10, rotation: 0 });
const circle = (id: string): OsdAnnotation =>
  vector(id, { type: 'circle', center: { x: 60, y: 45 }, radius: 25 });

function stateWith(annotations: readonly OsdAnnotation[]): AnnotationState<OsdFields> {
  const byImage: AnnotationState<OsdFields>['byImage'] = {};
  for (const a of annotations) byImage[a.imageId] = { ...byImage[a.imageId], [a.id]: a };
  return { byImage, changeCounter: 1 };
}

/** A saved annotation, as JSON: what a host reads back from a file. */
type Entry = Record<string, unknown> & {
  readonly id: string;
  readonly rawAnnotationData: { readonly format: string } & Record<string, unknown>;
};

/** `annotations` saved as a document, with masks re-encoded by `codec` when given. */
function saved(annotations: readonly OsdAnnotation[], codec?: MaskCodec): Entry[] {
  const state = stateWith(annotations);
  const doc = codec ? serialize(state, { maskCodec: codec }) : serialize(state);
  return JSON.parse(JSON.stringify(doc)) as Entry[];
}

/** One saved entry, with `changes` written over it. */
function edited(entry: Entry, changes: Record<string, unknown>): Entry {
  return { ...entry, ...changes };
}

/** `cocoRleCodec`, counting the masks it is asked to decode. */
function countingCoco(): { readonly options: DeserializeOptions; readonly decodes: () => number } {
  let decodes = 0;
  const codec: MaskCodec = {
    ...cocoRleCodec,
    decode(payload, options) {
      decodes++;
      return cocoRleCodec.decode!(payload as CocoRleSegmentation, options);
    },
  };
  return { options: { maskCodecs: createMaskCodecRegistry(codec) }, decodes: () => decodes };
}

/**
 * `entry` with its payload's `data` behind a proxy that counts reads of it:
 * a canonical mask is decoded with no codec to spy on, and nothing reads its
 * `data` but the decode.
 */
function countingReads(entry: Entry): { readonly entry: Entry; readonly reads: () => number } {
  let reads = 0;
  const raw = entry.rawAnnotationData as { format: string; data: Record<string, unknown> };
  const data = new Proxy(raw.data, {
    get(target, key, receiver) {
      reads++;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  return { entry: edited(entry, { rawAnnotationData: { ...raw, data } }), reads: () => reads };
}

function rejection(doc: unknown, options?: DeserializeOptions): SerializationError {
  let caught: unknown;
  try {
    deserialize(doc, options);
  } catch (err) {
    caught = err;
  }
  expect(caught, 'deserialize accepted the document').toBeInstanceOf(SerializationError);
  return caught as SerializationError;
}

/** Every issue the refusal's cause lists, in order. */
function issuesOf(err: SerializationError): string[] {
  expect(err.cause).toBeInstanceOf(v.ValiError);
  return (err.cause as v.ValiError<v.GenericSchema>).issues.map((issue) => issue.message);
}

/** The two kinds of mask payload a document can hold: a codec's, and the canonical one. */
const COCO = 'coco-rle';
const CANONICAL = 'osdlabel-mask';

describe('deserialize: a mask payload under vector geometry is refused as declared', () => {
  const cases = [CANONICAL, COCO].flatMap((format) =>
    (['rectangle', 'segmentationBrush'] as const).map((toolType) => [format, toolType] as const),
  );

  it.each(cases)(
    'a rectangle carrying a %s payload, recorded under the %s tool',
    (format, toolType) => {
      const coco = countingCoco();
      const [maskEntry] = saved([mask('m1')], format === COCO ? cocoRleCodec : undefined);
      const [rect] = saved([rectangle('r1')]);
      // An honest COCO mask alongside, which step 2 would decode.
      const [honest] = saved([mask('m2')], cocoRleCodec);
      const doc = [
        honest!,
        edited(rect!, { toolType, rawAnnotationData: maskEntry!.rawAnnotationData }),
      ];
      expect(doc[1]!.rawAnnotationData.format).toBe(format);

      const err = rejection(doc, coco.options);
      const pairing =
        `Annotation "r1" has rectangle geometry, but its rawAnnotationData's format is ` +
        `"${format}", not "fabric"`;
      expect(err.message).toBe(`Validation failed: ${pairing}`);
      // Recorded under the brush, the toolType is wrong for a rectangle too,
      // and is reported after the pairing, as the full schema orders them.
      expect(issuesOf(err)).toEqual(
        toolType === 'rectangle'
          ? [pairing]
          : [
              pairing,
              `Annotation "r1" has rectangle geometry, but its toolType is ` +
                `"segmentationBrush", not "rectangle"`,
            ],
      );
      expect(coco.decodes(), 'a mask was decoded before the refusal').toBe(0);
    },
  );
});

describe('deserialize: a Fabric payload under mask geometry is refused as declared', () => {
  it('names the annotation and the payload it holds', () => {
    const coco = countingCoco();
    const [maskEntry] = saved([mask('m1')]);
    const [rect] = saved([rectangle('r1')]);
    const [honest] = saved([mask('m2')], cocoRleCodec);
    const doc = [honest!, edited(maskEntry!, { rawAnnotationData: rect!.rawAnnotationData })];

    const err = rejection(doc, coco.options);
    expect(err.message).toBe(
      'Validation failed: Annotation "m1" has mask geometry, but its rawAnnotationData is a ' +
        '"fabric" payload, not "osdlabel-mask"',
    );
    expect(issuesOf(err)).toHaveLength(1);
    expect(coco.decodes()).toBe(0);
  });
});

describe('deserialize: a wrong Fabric class or toolType costs no decode', () => {
  it('refuses a rectangle whose payload is a Circle before decoding the masks', () => {
    const coco = countingCoco();
    const [rect] = saved([rectangle('r1')]);
    const [disc] = saved([circle('c1')]);
    const doc = [
      ...saved([mask('m1'), mask('m2')], cocoRleCodec),
      edited(rect!, { rawAnnotationData: disc!.rawAnnotationData }),
    ];
    const err = rejection(doc, coco.options);
    expect(err.message).toBe(
      'Validation failed: Annotation "r1" has rectangle geometry, but its rawAnnotationData ' +
        'is a Fabric Circle, not a Rect',
    );
    expect(coco.decodes()).toBe(0);
  });

  describe('over the decode budget', () => {
    // Each disc is a 21x21 box of cells plus its runs: about 500 a mask, so
    // a budget of 600 is spent by the second.
    const budget = { maxTotalMaskPixels: 600 };
    const masks = () => saved(['m1', 'm2', 'm3', 'm4'].map(mask), cocoRleCodec);

    it('the document as saved is refused for the budget, after decoding', () => {
      const coco = countingCoco();
      const err = rejection(masks(), { ...coco.options, ...budget });
      expect(err.message).toBe(
        "Failed to decode mask payload: Document's masks decode to more than 600 cells " +
          'and runs in total; raise maxTotalMaskPixels to allow it',
      );
      expect(coco.decodes()).toBeGreaterThan(0);
    });

    it('with one mask recorded under the rectangle tool, it is refused for that instead', () => {
      const coco = countingCoco();
      const doc = masks().map((e) => (e.id === 'm4' ? edited(e, { toolType: 'rectangle' }) : e));
      const err = rejection(doc, { ...coco.options, ...budget });
      expect(err.message).toBe(
        'Validation failed: Annotation "m4" has mask geometry, but its toolType is ' +
          '"rectangle", not "segmentationBrush"',
      );
      expect(coco.decodes(), 'a mask was decoded before the refusal').toBe(0);
    });

    it('the same holds for canonical payloads, which decode with no codec', () => {
      const doc = saved(['m1', 'm2', 'm3', 'm4'].map(mask));
      expect(rejection(doc, budget).message).toMatch(/^Failed to decode mask payload: /);
      // Had step 2 run, the budget would have been refused first.
      const tampered = doc.map((e) => (e.id === 'm1' ? edited(e, { toolType: 'point' }) : e));
      expect(rejection(tampered, budget).message).toBe(
        'Validation failed: Annotation "m1" has mask geometry, but its toolType is ' +
          '"point", not "segmentationBrush"',
      );
    });
  });

  describe('on a mask that cannot be decoded', () => {
    const corrupt = (entry: Entry): Entry => {
      const raw = entry.rawAnnotationData as { format: string; data: Record<string, unknown> };
      return edited(entry, { rawAnnotationData: { ...raw, data: { ...raw.data, counts: '' } } });
    };

    it.each([COCO, CANONICAL])(
      'a %s mask that would be skipped refuses the document when its toolType is wrong',
      (format) => {
        const codec = format === COCO ? cocoRleCodec : undefined;
        const [good, bad] = saved([mask('m1'), mask('m2')], codec);
        const doc = [good!, corrupt(bad!)];

        // As saved, the corrupt mask is skipped and the rest loads.
        const coco = countingCoco();
        const loaded = deserialize(doc, coco.options);
        expect(loaded.skipped.map((s) => s.id)).toEqual(['m2']);
        expect(Object.keys(loaded.byImage[imageId]!)).toEqual(['m1']);

        // Every payload's reads are counted, the codec's and the canonical
        // one's alike: had step 2 run, it would have read them.
        const after = countingCoco();
        const first = countingReads(good!);
        const second = countingReads(edited(corrupt(bad!), { toolType: 'circle' }));
        expect(rejection([first.entry, second.entry], after.options).message).toBe(
          'Validation failed: Annotation "m2" has mask geometry, but its toolType is ' +
            '"circle", not "segmentationBrush"',
        );
        expect(after.decodes()).toBe(0);
        expect(first.reads() + second.reads(), 'a mask payload was read').toBe(0);
      },
    );

    it.each([COCO, CANONICAL])(
      'a skipped %s mask does not save a document whose other annotation disagrees',
      (format) => {
        const codec = format === COCO ? cocoRleCodec : undefined;
        const [good, bad] = saved([mask('m1'), mask('m2')], codec);
        const [rect] = saved([rectangle('r1')]);
        const [disc] = saved([circle('c1')]);
        const coco = countingCoco();
        const masks = [countingReads(good!), countingReads(corrupt(bad!))];
        // In either order: the disagreement is found before any mask is read.
        const wrong = edited(rect!, { rawAnnotationData: disc!.rawAnnotationData });
        for (const doc of [
          [masks[0]!.entry, masks[1]!.entry, wrong],
          [wrong, masks[1]!.entry, masks[0]!.entry],
        ]) {
          expect(rejection(doc, coco.options).message).toBe(
            'Validation failed: Annotation "r1" has rectangle geometry, but its ' +
              'rawAnnotationData is a Fabric Circle, not a Rect',
          );
        }
        expect(coco.decodes()).toBe(0);
        expect(masks[0]!.reads() + masks[1]!.reads()).toBe(0);
      },
    );

    it('refuses the document for an entry with no string id whose fields disagree', () => {
      // Only the message reads the id. Gated on it, the checks let this entry
      // through to decoding, which skipped it, and the document loaded.
      const [good, bad] = saved([mask('m1'), mask('m2')]);
      const [rect] = saved([rectangle('r1')]);
      const idless = edited(corrupt(bad!), { id: 7, geometry: rect!.geometry });
      expect(rejection([good!, idless]).message).toBe(
        'Validation failed: An annotation with no string id has rectangle geometry, but its ' +
          'rawAnnotationData\'s format is "osdlabel-mask", not "fabric"',
      );
    });
  });
});

describe('deserialize: what step 1 cannot check is checked once the masks are decoded', () => {
  // A mask's geometry is replaced by the one its pixels give, so one that
  // declares none has nothing for step 1 to compare its toolType with. The
  // full schema compares it, after the decode; if the pixels do not decode,
  // the mask is skipped like any other.
  const withoutGeometry = (entry: Entry, changes: Record<string, unknown>): Entry => {
    const out: Record<string, unknown> = { ...entry, ...changes };
    delete out['geometry'];
    return out as Entry;
  };

  it('refuses a mask with no geometry under another tool, after decoding it', () => {
    const coco = countingCoco();
    const [entry] = saved([mask('m1')], cocoRleCodec);
    const err = rejection([withoutGeometry(entry!, { toolType: 'rectangle' })], coco.options);
    expect(err.message).toBe(
      'Validation failed: Annotation "m1" has mask geometry, but its toolType is ' +
        '"rectangle", not "segmentationBrush"',
    );
    expect(coco.decodes()).toBe(1);
  });

  it('skips one whose pixels do not decode either, and loads the rest', () => {
    const [good, bad] = saved([mask('m1'), mask('m2')]);
    const raw = bad!.rawAnnotationData as { format: string; data: Record<string, unknown> };
    const corrupt = withoutGeometry(bad!, {
      toolType: 'rectangle',
      rawAnnotationData: { ...raw, data: { ...raw.data, counts: '' } },
    });
    const { byImage, skipped } = deserialize([good!, corrupt]);
    expect(skipped.map((s) => s.id)).toEqual(['m2']);
    expect(Object.keys(byImage[imageId]!)).toEqual(['m1']);
  });
});

describe('deserialize: what is reported first', () => {
  it("reports an invalid decode bound ahead of the document's own faults", () => {
    // A fault in the call, whatever the document holds: a refusal of the
    // document must not hide it.
    const [m] = saved([mask('m1')]);
    const doc = [m!, edited(m!, { id: 'm2', toolType: 'point' })];
    expect(rejection(doc).message).toMatch(/^Validation failed: Annotation "m2" has mask/);
    for (const options of [{ maxTotalMaskPixels: Number.NaN }, { maxMaskPixels: -1 }]) {
      expect(rejection(doc, options).message).toMatch(
        /^Failed to decode mask payload: max(Total)?MaskPixels must be a non-negative number/,
      );
    }
  });

  it("reports a later annotation's disagreement ahead of an earlier one's missing field", () => {
    // Step 1 runs over the whole document before the full schema runs at all.
    const [rect, other] = saved([rectangle('r1'), rectangle('r2')]);
    const [disc] = saved([circle('c1')]);
    const missing: Record<string, unknown> = { ...rect! };
    delete missing['createdAt'];
    const doc = [missing, edited(other!, { rawAnnotationData: disc!.rawAnnotationData })];
    expect(rejection(doc).message).toBe(
      'Validation failed: Annotation "r2" has rectangle geometry, but its rawAnnotationData ' +
        'is a Fabric Circle, not a Rect',
    );
    expect(rejection([missing]).message).toMatch(/^Validation failed: Invalid key/);
  });
});

describe('deserialize: documents that loaded before still load', () => {
  it('round-trips vector shapes and masks in the canonical encoding', () => {
    const annotations = [rectangle('r1'), circle('c1'), mask('m1')];
    const { byImage, skipped } = deserialize(saved(annotations));
    expect(skipped).toEqual([]);
    expect(Object.values(byImage[imageId]!)).toEqual(annotations);
  });

  it('round-trips masks exported through a codec', () => {
    const coco = countingCoco();
    const annotations = [rectangle('r1'), mask('m1'), mask('m2')];
    const { byImage, skipped } = deserialize(saved(annotations, cocoRleCodec), coco.options);
    expect(skipped).toEqual([]);
    expect(coco.decodes()).toBe(2);
    expect(Object.values(byImage[imageId]!)).toEqual(annotations);
  });

  it.each([CANONICAL, COCO])(
    'loads a %s mask that declares no geometry, from its pixels',
    (format) => {
      const coco = countingCoco();
      const original = mask('m1');
      const [entry] = saved([original], format === COCO ? cocoRleCodec : undefined);
      const withoutGeometry: Record<string, unknown> = { ...entry! };
      delete withoutGeometry['geometry'];
      const { byImage } = deserialize([withoutGeometry], coco.options);
      expect(byImage[imageId]![original.id]).toEqual(original);
    },
  );

  it.each([CANONICAL, COCO])(
    'loads a %s mask whose declared mask geometry is wrong in every number',
    (format) => {
      const coco = countingCoco();
      const original = mask('m1');
      const [entry] = saved([original], format === COCO ? cocoRleCodec : undefined);
      const doc = [edited(entry!, { geometry: { type: 'mask', width: 'wide' } })];
      const { byImage } = deserialize(doc, coco.options);
      expect(byImage[imageId]![original.id]!.geometry).toEqual(original.geometry);
    },
  );
});

describe('deserialize: an entry of the wrong shape is left to the full schema', () => {
  // Step 1 reads only the fields it compares, and passes what it cannot read.
  // A vector entry is not touched by step 2, so step 3 sees it as written,
  // and the refusal is exactly what `OsdAnnotationSchema` says of it.
  const [rect] = saved([rectangle('r1')]);
  const malformed: readonly (readonly [string, unknown])[] = [
    ['no geometry', edited(rect!, { geometry: undefined })],
    ['a null geometry', edited(rect!, { geometry: null })],
    ['a geometry type no geometry has', edited(rect!, { geometry: { type: 'blob' } })],
    ['a toolType no tool has', edited(rect!, { toolType: 'brush' })],
    ['a payload that is a string', edited(rect!, { rawAnnotationData: 'fabric' })],
    ['a payload with no format', edited(rect!, { rawAnnotationData: { data: {} } })],
    [
      'a Fabric payload with no class',
      edited(rect!, { rawAnnotationData: { format: 'fabric', fabricVersion: '7', data: {} } }),
    ],
    ['no id', edited(rect!, { id: 7 })],
    ['null', null],
  ];

  it.each(malformed)('%s', (_name, entry) => {
    const doc = [entry];
    const expected = v.safeParse(v.array(OsdAnnotationSchema), doc);
    expect(expected.success).toBe(false);
    expect(rejection(doc).message).toBe(`Validation failed: ${expected.issues![0]!.message}`);
  });

  it('still reports a mismatch it can read beside a field it cannot', () => {
    // A toolType no tool has is the full schema's to report, but the payload
    // under the rectangle is a mask's, which step 1 can see.
    const [m] = saved([mask('m1')]);
    const doc = [edited(rect!, { toolType: 'brush', rawAnnotationData: m!.rawAnnotationData })];
    expect(rejection(doc).message).toBe(
      'Validation failed: Annotation "r1" has rectangle geometry, but its rawAnnotationData\'s ' +
        'format is "osdlabel-mask", not "fabric"',
    );
  });
});
