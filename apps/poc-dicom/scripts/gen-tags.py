"""Generate packages/dicom/src/tags.ts from pydicom's copy of the DICOM data dictionary.

    .venv/bin/python -I scripts/gen-tags.py > ../../packages/dicom/src/tags.ts

Only the attributes the adapter reads or writes are listed: the point of a thin
adapter is that it does not ship the whole dictionary (dcmjs's is ~1 MB).
"""

from pydicom.datadict import dictionary_VR, tag_for_keyword

KEYWORDS = """
FileMetaInformationGroupLength FileMetaInformationVersion MediaStorageSOPClassUID
MediaStorageSOPInstanceUID TransferSyntaxUID ImplementationClassUID ImplementationVersionName
SpecificCharacterSet ImageType InstanceCreationDate InstanceCreationTime SOPClassUID SOPInstanceUID
StudyDate SeriesDate ContentDate StudyTime SeriesTime ContentTime AccessionNumber Modality
Manufacturer ReferringPhysicianName CodeValue CodingSchemeDesignator CodingSchemeVersion CodeMeaning
MappingResource StudyDescription SeriesDescription ManufacturerModelName ReferencedSeriesSequence
ReferencedSOPClassUID ReferencedSOPInstanceUID ReferencedFrameNumber ReferencedSOPSequence
DerivationDescription SourceImageSequence RecommendedDisplayFrameRate DerivationImageSequence
DerivationCodeSequence ReferencedImageSequence
PatientName PatientID PatientBirthDate PatientSex
CineRate SliceThickness SpacingBetweenSlices DeviceSerialNumber SoftwareVersions
DistanceSourceToDetector DistanceSourceToPatient EstimatedRadiographicMagnificationFactor
FrameTime FrameTimeVector ImagerPixelSpacing ActualFrameDuration PreferredPlaybackSequencing
NominalScannedPixelSpacing FrameLabelVector
SequenceOfUltrasoundRegions RegionSpatialFormat RegionDataType RegionFlags RegionLocationMinX0
RegionLocationMinY0 RegionLocationMaxX1 RegionLocationMaxY1 ReferencePixelX0 ReferencePixelY0
PhysicalUnitsXDirection PhysicalUnitsYDirection ReferencePixelPhysicalValueX
ReferencePixelPhysicalValueY PhysicalDeltaX PhysicalDeltaY TransducerFrequency
StudyInstanceUID SeriesInstanceUID StudyID SeriesNumber InstanceNumber ImagePositionPatient
ImageOrientationPatient FrameOfReferenceUID PositionReferenceIndicator SliceLocation
DimensionOrganizationUID DimensionIndexPointer FunctionalGroupPointer DimensionOrganizationSequence
DimensionIndexSequence DimensionDescriptionLabel DimensionIndexValues FrameContentSequence
PlanePositionSequence PlaneOrientationSequence DimensionOrganizationType SliceVector
SamplesPerPixel PhotometricInterpretation PlanarConfiguration NumberOfFrames FrameIncrementPointer
Rows Columns PixelSpacing BitsAllocated BitsStored HighBit PixelRepresentation
PixelSpacingCalibrationType PixelSpacingCalibrationDescription WindowCenter WindowWidth
RescaleIntercept RescaleSlope RescaleType WindowCenterWidthExplanation VOILUTFunction
LossyImageCompression LossyImageCompressionRatio LossyImageCompressionMethod ModalityLUTSequence
LUTDescriptor LUTExplanation ModalityLUTType LUTData VOILUTSequence PixelMeasuresSequence
FrameVOILUTSequence PixelValueTransformationSequence PresentationLUTShape
SharedFunctionalGroupsSequence PerFrameFunctionalGroupsSequence
TotalPixelMatrixColumns TotalPixelMatrixRows TotalPixelMatrixOriginSequence ImageOrientationSlide
PlanePositionSlideSequence ColumnPositionInTotalImagePixelMatrix RowPositionInTotalImagePixelMatrix
XOffsetInSlideCoordinateSystem YOffsetInSlideCoordinateSystem ZOffsetInSlideCoordinateSystem
TotalPixelMatrixFocalPlanes NumberOfOpticalPaths OpticalPathSequence OpticalPathIdentifier
ContainerIdentifier SpecimenDescriptionSequence ImagedVolumeWidth ImagedVolumeHeight
ImagedVolumeDepth PixelOriginInterpretation
ExtendedOffsetTable ExtendedOffsetTableLengths PixelData
ValueType ConceptNameCodeSequence ContinuityOfContent ContentSequence RelationshipType TextValue UID
ConceptCodeSequence MeasuredValueSequence NumericValue MeasurementUnitsCodeSequence GraphicData
GraphicType ReferencedFrameOfReferenceUID CompletionFlag VerificationFlag ContentTemplateSequence
TemplateIdentifier CurrentRequestedProcedureEvidenceSequence PerformedProcedureCodeSequence
ReferencedRequestSequence PreliminaryFlag ObservationDateTime
SegmentationType SegmentSequence SegmentedPropertyCategoryCodeSequence SegmentNumber SegmentLabel
SegmentDescription SegmentAlgorithmType SegmentAlgorithmName SegmentIdentificationSequence
ReferencedSegmentNumber RecommendedDisplayCIELabValue SegmentedPropertyTypeCodeSequence
SegmentsOverlap TrackingID TrackingUID ContentLabel ContentDescription ContentCreatorName
AnnotationCoordinateType AnnotationGroupSequence AnnotationGroupUID AnnotationGroupLabel
AnnotationGroupDescription AnnotationGroupGenerationType AnnotationPropertyCategoryCodeSequence
AnnotationPropertyTypeCodeSequence NumberOfAnnotations AnnotationAppliesToAllOpticalPaths
AnnotationAppliesToAllZPlanes AnnotationGroupNumber PointCoordinatesData DoublePointCoordinatesData
LongPrimitivePointIndexList AnnotationGroupAlgorithmIdentificationSequence
AlgorithmFamilyCodeSequence AlgorithmName AlgorithmVersion
PrimaryAnatomicStructureSequence
PersonName ReferencedPerformedProcedureStepSequence PertinentOtherEvidenceSequence
CommonZCoordinateValue IssuerOfTheContainerIdentifierSequence ContainerTypeCodeSequence
SpecimenIdentifier SpecimenUID IssuerOfTheSpecimenIdentifierSequence SpecimenPreparationSequence
ReferencedInstanceSequence ObservationUID MaximumFractionalValue SegmentationFractionalType
RecommendedDisplayGrayscaleValue AnatomicRegionSequence ContentQualification BurnedInAnnotation
AcquisitionContextSequence TimezoneOffsetFromUTC Laterality PatientOrientation SpatialLocationsPreserved PurposeOfReferenceCodeSequence
""".split()


def main() -> None:
    print("// Generated by apps/poc-dicom/scripts/gen-tags.py from pydicom's data dictionary.")
    print("// Do not edit by hand.")
    print("")
    print("/** Value Representation codes (PS3.5 6.2). */")
    vrs = set()
    rows = []
    for kw in KEYWORDS:
        tag = tag_for_keyword(kw)
        if tag is None:
            raise SystemExit(f"unknown keyword {kw}")
        vr = dictionary_VR(tag)
        # Ambiguous VRs ('US or SS', 'OB or OW', ...): take the first; readers
        # of these attributes handle the alternatives explicitly.
        vr = vr.split(" or ")[0]
        vrs.add(vr)
        rows.append((kw, tag, vr))
    all_vrs = sorted(vrs | {"AE", "AS", "AT", "CS", "DA", "DS", "DT", "FD", "FL", "IS", "LO", "LT",
                             "OB", "OD", "OF", "OL", "OV", "OW", "PN", "SH", "SL", "SQ", "SS", "ST",
                             "SV", "TM", "UC", "UI", "UL", "UN", "UR", "US", "UT", "UV"})
    print("export type Vr =\n" + "\n".join(f"  | '{v}'" for v in all_vrs) + ";")
    print("")
    print("/** One dictionary entry: the tag as `(group << 16) | element`, and its VR. */")
    print("export interface TagEntry {\n  readonly tag: number;\n  readonly vr: Vr;\n}")
    print("")
    print("/** The attributes this adapter reads or writes, by keyword. */")
    print("export const TAGS = {")
    for kw, tag, vr in rows:
        print(f"  {kw}: {{ tag: 0x{tag:08x}, vr: '{vr}' }},")
    print("} as const satisfies Record<string, TagEntry>;")
    print("")
    print("export type Keyword = keyof typeof TAGS;")


if __name__ == "__main__":
    main()
