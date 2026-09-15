// Always removes the disposable window this suite created — the operator's own TextEdit
// (a different pid) is never touched. Safe to run when no fixture exists.
import { disposeFixture } from './helpers/cu-fixture.mjs';

export default async function globalTeardown() {
  disposeFixture();
}
