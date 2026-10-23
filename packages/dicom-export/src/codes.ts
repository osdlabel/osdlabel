import { el, seq, type WriteDataset, type WriteElement } from '@osdlabel/dicom';
import type { Keyword } from '@osdlabel/dicom';

/** A coded concept (PS3.3 8.8): the vocabulary DICOM speaks instead of free text. */
export interface Code {
  readonly value: string;
  readonly scheme: string;
  readonly meaning: string;
}

export const code = (value: string, scheme: string, meaning: string): Code => ({
  value,
  scheme,
  meaning,
});

/** Codes used by the writers. Values follow highdicom's `codes` module (DCM, SCT, UCUM). */
export const CODES = {
  imagingMeasurementReport: code('126000', 'DCM', 'Imaging Measurement Report'),
  languageOfContent: code('121049', 'DCM', 'Language of Content Item and Descendants'),
  englishUS: code('en-US', 'RFC5646', 'English (United States)'),
  observerType: code('121005', 'DCM', 'Observer Type'),
  device: code('121007', 'DCM', 'Device'),
  deviceObserverUid: code('121012', 'DCM', 'Device Observer UID'),
  deviceObserverName: code('121013', 'DCM', 'Device Observer Name'),
  procedureReported: code('121058', 'DCM', 'Procedure reported'),
  imagingProcedure: code('363679005', 'SCT', 'Imaging procedure'),
  imageLibrary: code('111028', 'DCM', 'Image Library'),
  imageLibraryGroup: code('126200', 'DCM', 'Image Library Group'),
  imagingMeasurements: code('126010', 'DCM', 'Imaging Measurements'),
  measurementGroup: code('125007', 'DCM', 'Measurement Group'),
  trackingIdentifier: code('112039', 'DCM', 'Tracking Identifier'),
  trackingUniqueIdentifier: code('112040', 'DCM', 'Tracking Unique Identifier'),
  finding: code('121071', 'DCM', 'Finding'),
  imageRegion: code('111030', 'DCM', 'Image Region'),
  length: code('410668003', 'SCT', 'Length'),
  area: code('42798000', 'SCT', 'Area'),
  perimeter: code('131191004', 'SCT', 'Perimeter'),
  diameter: code('81827009', 'SCT', 'Diameter'),
  tissue: code('85756007', 'SCT', 'Tissue'),
  morphologicallyAlteredStructure: code('49755003', 'SCT', 'Morphologically Altered Structure'),
  sourceImageForProcessing: code('121322', 'DCM', 'Source image for image processing operation'),
  segmentation: code('113076', 'DCM', 'Segmentation'),
  mm: code('mm', 'UCUM', 'millimeter'),
  mm2: code('mm2', 'UCUM', 'square millimeter'),
  um: code('um', 'UCUM', 'micrometer'),
  um2: code('um2', 'UCUM', 'square micrometer'),
} as const;

/** One code sequence item. */
export function codeItem(c: Code): WriteDataset {
  return [
    el('CodeValue', c.value),
    el('CodingSchemeDesignator', c.scheme),
    el('CodeMeaning', c.meaning),
  ];
}

/** A code sequence element holding a single code. */
export function codeSeq(keyword: Keyword, c: Code): WriteElement {
  return seq(keyword, [codeItem(c)]);
}

/** UCUM unit code for a display unit as osdlabel spells it. */
export function ucum(unit: string, squared: boolean): Code {
  if (unit === 'mm') return squared ? CODES.mm2 : CODES.mm;
  if (unit === 'µm' || unit === 'um') return squared ? CODES.um2 : CODES.um;
  if (unit === 'cm')
    return squared ? code('cm2', 'UCUM', 'square centimeter') : code('cm', 'UCUM', 'centimeter');
  throw new Error(`no UCUM mapping for unit '${unit}'`);
}
