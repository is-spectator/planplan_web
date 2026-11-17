import { BUILD_FINGERPRINT } from '../src/ai/runtime-config.js';
import { DATASET_REVIEW } from './review.js';

/** The report producer and runtime admission check must identify the same build. */
export function evaluationMetadata(model: string, outputMode: 'strict' | 'compact', requestTimeoutMs: number, revision: string) {
  return {
    dataset: BUILD_FINGERPRINT.dataset,
    prompt: BUILD_FINGERPRINT.prompt,
    protocol: BUILD_FINGERPRINT.protocol,
    runtime: { ...BUILD_FINGERPRINT, outputMode, requestTimeoutMs },
    model,
    review: DATASET_REVIEW,
    revision,
  };
}
