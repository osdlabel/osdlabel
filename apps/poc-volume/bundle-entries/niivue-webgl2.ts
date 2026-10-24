// What a Niivue 3D-cell adapter pulls in: the WebGL2 build and the two
// helpers used to hand it an in-memory volume.
import NiiVue, {
  NiiDataType,
  SLICE_TYPE,
  createStreamingNVImage,
  nii2volume,
} from '@niivue/niivue/webgl2';

export { NiiVue, NiiDataType, SLICE_TYPE, createStreamingNVImage, nii2volume };
