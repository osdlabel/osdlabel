import { expect } from 'vitest';
import { Control, InteractiveFabricObject, controlsUtils, type FabricObject } from 'fabric';

/**
 * A host's own controls, installed the way Fabric documents: by overriding
 * `InteractiveFabricObject.createControls`, which every object's constructor
 * reads, rectangles, circles and multi-selections included.
 *
 * The host's set is Fabric's defaults without the rotation handle (`mtr`), as
 * an app that disables rotation has it, each handle an instance of the host's
 * own `Control` subclass, drawn by its own renderer at its own size.
 */
export class HostControl extends Control {}

/** The host's renderer, on every handle of its set. */
export const hostRender: Control['render'] = () => {};

/** The size the host draws every handle at; Fabric's default is 13. */
export const HOST_SIZE = 21;

/** A fresh copy of the host's set: Fabric's defaults less `mtr`, as `HostControl`s. */
export function hostControlSet(): Record<string, Control> {
  return Object.fromEntries(
    Object.entries(controlsUtils.createObjectDefaultControls())
      .filter(([key]) => key !== 'mtr')
      .map(([key, control]) => [
        key,
        new HostControl({ ...control, render: hostRender, sizeX: HOST_SIZE, sizeY: HOST_SIZE }),
      ]),
  );
}

/**
 * Make every object constructed from now on get `make()` as its controls.
 * Pass a function returning one set to share it, and its instances, among
 * all objects, as Fabric's comment on `createControls` suggests. Returns the
 * restore, for `afterEach`.
 */
export function overrideCreateControls(make: () => Record<string, Control>): () => void {
  const original = InteractiveFabricObject.createControls;
  InteractiveFabricObject.createControls = () => ({ controls: make() });
  return () => {
    InteractiveFabricObject.createControls = original;
  };
}

/** `object`'s handles are all the host's: its class, its renderer, its size. */
export function expectHostHandles(object: FabricObject, what: string): void {
  for (const [key, control] of Object.entries(object.controls)) {
    expect(control, `${what}: ${key} is not the host's`).toBeInstanceOf(HostControl);
    expect(control.render, `${what}: ${key} lost the host's renderer`).toBe(hostRender);
    expect(control.sizeX, `${what}: ${key} lost the host's size`).toBe(HOST_SIZE);
  }
}

/**
 * What each control of `controls` is, by key: its own properties, functions
 * by reference. For checking that a set shared among objects was not changed.
 */
export function snapshotControls(
  controls: Readonly<Record<string, Control>>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(controls).map(([key, control]) => [key, { ...control }]),
  );
}
