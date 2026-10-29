import type { AnnotationId, Geometry } from '@osdlabel/annotation';
import type { AnnotationState, ImageId } from '@osdlabel/viewer-api';
import {
  dissolveGroupSelection,
  isGroupSelection,
  reselectWhenAdded,
  type FabricRawAnnotationData,
} from '@osdlabel/fabric-annotations';
import type { ActiveSelection, Canvas, FabricObject, Transform } from 'fabric';
import { processObjectModified } from './tool-factory.js';
import type { OsdFields } from './types.js';

/** What an edit changes on one annotation: where it is, and the Fabric data that paints it. */
export interface ObjectModifiedPatch {
  readonly geometry: Geometry;
  readonly rawAnnotationData: FabricRawAnnotationData;
}

/** One annotation's part of a multi-selection edit. */
export interface ObjectModifiedUpdate {
  readonly id: AnnotationId;
  readonly patch: ObjectModifiedPatch;
}

/**
 * Read each member of a dissolved multi-selection through
 * {@link processObjectModified}, as if it had been edited on its own. Members
 * that are not stored annotations of `imageId` are skipped.
 *
 * The members must already carry their absolute transforms (see
 * `dissolveGroupSelection`): read inside the selection, a member's
 * left/top/scale/angle are relative to the selection.
 */
export function processGroupModified(
  members: readonly FabricObject[],
  annotationState: AnnotationState<OsdFields>,
  imageId: ImageId,
): ObjectModifiedUpdate[] {
  const updates: ObjectModifiedUpdate[] = [];
  for (const member of members) {
    const result = processObjectModified(member, annotationState, imageId);
    if (!result?.geometry) continue;
    updates.push({
      id: result.id,
      patch: { geometry: result.geometry, rawAnnotationData: result.rawAnnotationData },
    });
  }
  return updates;
}

/** Options for {@link enableObjectModifiedCommits}. */
export interface ObjectModifiedCommitOptions {
  /** The overlay whose canvas reports the edits. */
  readonly overlay: { readonly canvas: Canvas };
  /** The image the overlay's annotations belong to. */
  readonly imageId: ImageId;
  /** The current annotation state, read when an edit is committed. */
  readonly getAnnotationState: () => AnnotationState<OsdFields>;
  /** Commit an edit of one annotation (`actions.updateAnnotation`). */
  readonly updateAnnotation: (id: AnnotationId, patch: ObjectModifiedPatch) => void;
  /** Commit an edit of several annotations as one change (`actions.updateAnnotations`). */
  readonly updateAnnotations: (updates: readonly ObjectModifiedUpdate[]) => void;
}

/**
 * Save every edit Fabric reports on the overlay's canvas with
 * `object:modified`: a move, resize or rotation of one annotation, or of a
 * multi-selection. Both bindings' `useAnnotationTool` run it. Returns the
 * teardown.
 *
 * **A multi-selection** (Fabric's `ActiveSelection`) is reported as one event
 * whose target is the selection itself, with no annotation id, and with every
 * member still inside it, its left/top/scale/angle relative to the selection.
 * Fabric bakes the selection's transform into the members only when it is
 * dissolved, and fires nothing then. So the selection is dissolved first,
 * each member is read on its own, all of them are committed with
 * `updateAnnotations` as one change (one rebuild of the canvas), and the same
 * annotations are selected again once the rebuild has added their new
 * objects. If the selection was dissolved before Fabric reported the edit (a
 * tool switch mid-drag discards it), its members are the ones it held when the
 * transform began.
 *
 * **Every commit waits for a microtask**, until Fabric has finished handling
 * the pointer release. Fabric fires `object:modified` while the transform is
 * still current; a commit inside the event that rebuilds the canvas at once
 * (Solid runs the rebuild synchronously) removes the object mid-transform, and
 * Fabric, ending the transform on the way, reported the same edit a second
 * time. Dissolving a selection inside the event does the same.
 *
 * An edit reported before the teardown is still committed after it, since it
 * belongs to the image it was made on; it is just not reselected.
 */
export function enableObjectModifiedCommits(options: ObjectModifiedCommitOptions): () => void {
  const { overlay, imageId, getAnnotationState, updateAnnotation, updateAnnotations } = options;
  const canvas = overlay.canvas;
  let disposed = false;
  let cancelReselect: (() => void) | undefined;
  /** A selection's members when its transform began, for one dissolved before the report. */
  const membersAtStart = new WeakMap<Transform, readonly FabricObject[]>();

  const onBeforeTransform = ({ transform }: { readonly transform: Transform }): void => {
    if (isGroupSelection(transform.target)) {
      membersAtStart.set(transform, transform.target.getObjects());
    }
  };

  const commitOne = (target: FabricObject): void => {
    const result = processObjectModified(target, getAnnotationState(), imageId);
    if (!result?.geometry) return;
    updateAnnotation(result.id, {
      geometry: result.geometry,
      rawAnnotationData: result.rawAnnotationData,
    });
  };

  const commitGroup = (
    selection: ActiveSelection,
    atStart: readonly FabricObject[] | undefined,
  ): void => {
    const dissolved = dissolveGroupSelection(canvas, selection);
    const members = dissolved.length > 0 ? dissolved : (atStart ?? []);
    const updates = processGroupModified(members, getAnnotationState(), imageId);
    if (updates.length === 0) return;
    if (!disposed) {
      cancelReselect?.();
      cancelReselect = reselectWhenAdded(
        canvas,
        updates.map((u) => u.id),
      );
    }
    updateAnnotations(updates);
  };

  const onModified = ({
    target,
    transform,
  }: {
    readonly target: FabricObject;
    readonly transform?: Transform;
  }): void => {
    const atStart = transform ? membersAtStart.get(transform) : undefined;
    queueMicrotask(() => {
      if (isGroupSelection(target)) commitGroup(target, atStart);
      else commitOne(target);
    });
  };

  canvas.on('before:transform', onBeforeTransform);
  canvas.on('object:modified', onModified);
  return () => {
    disposed = true;
    cancelReselect?.();
    cancelReselect = undefined;
    canvas.off('before:transform', onBeforeTransform);
    canvas.off('object:modified', onModified);
  };
}
