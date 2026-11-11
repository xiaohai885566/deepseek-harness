/**
 * Worker-preview bootstrap: the one module preview.html adds ahead of the
 * stock entry tag. The runtime's optional source stage owns the pre-Cordis
 * chooser; the unchanged Host connector then owns the Worker handshake.
 * Everything after those calls is the served startup chain verbatim.
 */
import DshWorker from '@deepseek-ai/dsh-experimental-webworker-runtime/worker?worker'
import {
  chooseWorkerHostSource, connectWorkerHost, IMAGE_FILE_NAME, resetPersistedVfs,
} from '@deepseek-ai/dsh-experimental-webworker-runtime/client'

// `?reset-vfs` throws away the persisted filesystem before the host mounts, for
// state that outlived the build that wrote it.
if (new URL(location.href).searchParams.has('reset-vfs')) await resetPersistedVfs()

const image = `preview/${IMAGE_FILE_NAME}`
const source = await chooseWorkerHostSource({ image })
await connectWorkerHost(new DshWorker({ name: 'dsh-host' }), { image, overlays: source.overlays })
