import { join } from 'node:path';
import { createDeepSeekInternalRuntime } from './deepseek-runtime.mjs';
import { createLoopRuntime } from './loop-runtime.mjs';
import { TrajectoryRecorder } from './trajectory-recorder.mjs';
import { fail } from './contracts.mjs';

export function createTrajectoryLoop(root, { recorderRoot = join(root, 'trajectory'), authorizeExport, mock = false, afterRecordingPhase, afterRecordingStorePhase, ...options } = {}) {
  if (!mock && options.mode === 'live') fail('T0_OFFLINE_ONLY');
  const runtime = mock ? createLoopRuntime(root, options) : createDeepSeekInternalRuntime(root, { ...options, loop: true });
  const recorder = new TrajectoryRecorder({ runtime, root: recorderRoot, authorizeExport, afterPhase: afterRecordingPhase, afterStorePhase: afterRecordingStorePhase });
  // Execution methods are pass-through. Recording is explicit and cannot make
  // a succeeded execution fail or add model calls/checkpoints to its history.
  return Object.freeze({ create: input => runtime.harness.create(input), run: (id, context, options) => runtime.harness.run(id, context, options), reconcile: (id, context, input) => runtime.harness.reconcile(id, context, input), capture: (id, context) => recorder.capture(id, context), export: (id, context) => recorder.export(id, context), recoverRecording: (id, context) => recorder.recoverRecording(id, context) });
}
