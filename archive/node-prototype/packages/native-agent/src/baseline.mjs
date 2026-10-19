// Read-only byte-identical finance dependencies from the accepted workspace.
import { fileURLToPath } from 'node:url';
export const BASELINE_ROOT = fileURLToPath(new URL('../../../vendor/flowcredit-finance/', import.meta.url));
export { createModelBackend } from '../../../vendor/flowcredit-finance/src/model-backend.js';
export { EvidenceAssessmentService } from '../../../vendor/flowcredit-finance/src/evidence-service.js';
export { acquirePublicEvidence } from '../../../vendor/flowcredit-finance/src/public-evidence.js';
export { minimaxHtml } from '../../../vendor/flowcredit-finance/test/recovery-public-fixture.js';
export { digest, stable } from '../../../vendor/flowcredit-finance/src/evidence-package.js';
