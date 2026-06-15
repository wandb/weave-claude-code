// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { VERSION } from './version.mjs';

export interface TracerProviderArgs {
  /** `entity/project` — same format the daemon validates. */
  weaveProject: string;
  apiKey: string;
  /** Trace endpoint base, no trailing slash (e.g. `https://trace.wandb.ai`). */
  baseUrl: string;
  /** Top-level agent name; also becomes `service.name`. */
  agentName: string;
  debug?: boolean;
}

/**
 * Build a NodeTracerProvider wired to the Weave Agents OTLP endpoint. This is
 * the exporter setup the daemon does in `GlobalDaemon.initTracer`, factored out
 * so the daemonless session-end path constructs an identical provider. The
 * daemon retains its own copy (additive discipline — this module is only used
 * by the session-end path). Throws on a malformed `weaveProject`.
 */
export function createTracerProvider(args: TracerProviderArgs): NodeTracerProvider {
  const [entity, project] = args.weaveProject.split('/', 2);
  if (!entity || !project) {
    throw new Error(`Invalid weave_project format: '${args.weaveProject}' (expected entity/project)`);
  }

  if (args.debug) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
  }

  const resource = resourceFromAttributes({
    'service.name': args.agentName,
    'service.version': VERSION,
    'wandb.entity': entity,
    'wandb.project': project,
  });

  const exporter = new OTLPTraceExporter({
    url: `${args.baseUrl}/agents/otel/v1/traces`,
    headers: { 'wandb-api-key': args.apiKey },
  });

  const provider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  return provider;
}
