---
name: onnxruntime-node version clash
description: Multiple onnxruntime-node versions in the pnpm workspace load the wrong shared library at runtime
---
Rule: pin `onnxruntime-node` to the exact version already hoisted in the workspace (currently 1.24.3, bundled by @huggingface/transformers). Check with `ls node_modules/.pnpm | grep onnxruntime` before adding it anywhere.

**Why:** With two versions present, the native binding of one version resolved `libonnxruntime.so.1` from the other, failing at runtime with `version 'VERS_X' not found`. Typecheck and install succeed; it only breaks when a session is created.

**How to apply:** Whenever adding or upgrading onnxruntime-node (or transformers.js which bundles it) in any workspace package, keep versions identical across the monorepo.

Related SCRFD lesson: when matching SCRFD output tensors to strides, match by trailing dim (scores are (N,1), boxes (N,4)) — matching by raw data length confuses stride-8 scores (3200 elems) with stride-16 boxes (3200 elems), silently dropping detections.
