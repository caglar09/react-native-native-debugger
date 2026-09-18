'use strict';

const path = require('path');
const { DashboardClient } = require('./dashboard-client');

function jsonText(value) {
  return JSON.stringify(value, null, 2);
}

function toolSuccess(value, intro) {
  const text = intro ? `${intro}\n\n${jsonText(value)}` : jsonText(value);
  return {
    content: [{ type: 'text', text }],
    structuredContent: value
  };
}

function toolFailure(error) {
  const message = error && error.message ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: 'text', text: message }]
  };
}

function safeTool(handler) {
  return async (input) => {
    try {
      return await handler(input || {});
    } catch (error) {
      return toolFailure(error);
    }
  };
}

async function loadMcpDependencies() {
  const [{ McpServer }, { StdioServerTransport }, zodModule] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('zod')
  ]);
  return {
    McpServer,
    StdioServerTransport,
    z: zodModule.z
  };
}

async function runMcp(args = {}) {
  const { McpServer, StdioServerTransport, z } = await loadMcpDependencies();
  const pkg = require(path.join(__dirname, '../../package.json'));
  const dashboardUrl = args.connect || `http://${args.host || '127.0.0.1'}:${args.port || 9876}`;
  const client = new DashboardClient(dashboardUrl, { timeoutMs: args.mcpTimeout || 5000 });

  const server = new McpServer(
    {
      name: 'react-native-native-debugger',
      version: pkg.version
    },
    {
      instructions: [
        'This server exposes a live development-only React Native native debugging session.',
        'Call native_debugger_status first.',
        'Start log/error searches with scope="app"; expand to scope="all" only when OS, daemon, permission, or network-process correlation is useful.',
        'Use stable log ids with get_native_log_context before concluding causality.',
        'Treat captured logs and measured telemetry as evidence; clearly separate them from inference.',
        'Never invent missing stack frames, network metadata, package attribution, or root causes.'
      ].join(' ')
    }
  );

  const readOnlyAnnotations = {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false
  };

  server.registerTool(
    'native_debugger_status',
    {
      title: 'React Native Native Debugger Status',
      annotations: readOnlyAnnotations,
      description: 'Use this first. Returns the connected app/device/session, collector health, captured-log statistics, and latest main-process runtime telemetry from the active React Native Native Debugger dashboard.',
      inputSchema: {}
    },
    safeTool(async () => {
      const [health, session, stats] = await Promise.all([
        client.health(),
        client.session(),
        client.stats()
      ]);
      const primaryProcess = session?.app?.primaryProcess || '';
      let runtime = { available: false };
      try {
        runtime = await client.runtime(primaryProcess);
      } catch {}
      return toolSuccess({
        dashboardUrl,
        health,
        session,
        stats,
        runtime
      });
    })
  );

  server.registerTool(
    'search_native_logs',
    {
      title: 'Search Native Logs',
      annotations: readOnlyAnnotations,
      description: 'Search the complete captured native-log session. Default scope is the current app only. Use scope="all" when investigating related OS/daemon/network processes. Results include stable log ids that can be passed to get_native_log_context.',
      inputSchema: {
        scope: z.enum(['app', 'all']).optional().describe('app = current React Native app only; all = every captured process'),
        text: z.string().optional().describe('Full-text search across the normalized event, message, stack/source metadata, and raw native log'),
        levels: z.array(z.string()).optional().describe('Severity filters such as debug, info, warn, error, fatal'),
        process: z.string().optional(),
        package: z.string().optional(),
        service: z.string().optional(),
        subsystem: z.string().optional(),
        tag: z.string().optional(),
        lookback_ms: z.number().int().min(0).optional().describe('Only include logs received within this many milliseconds from now'),
        limit: z.number().int().min(1).max(200).optional(),
        order: z.enum(['desc', 'asc']).optional().describe('desc = newest first; asc = oldest first')
      }
    },
    safeTool(async (input) => {
      const result = await client.searchLogs({
        scope: input.scope || 'app',
        text: input.text,
        levels: input.levels,
        process: input.process,
        package: input.package,
        service: input.service,
        subsystem: input.subsystem,
        tag: input.tag,
        lookbackMs: input.lookback_ms,
        limit: input.limit || 100,
        order: input.order || 'desc'
      });
      return toolSuccess(result, 'Native log search results. Treat raw records as evidence; do not infer fields that are absent.');
    })
  );

  server.registerTool(
    'get_native_log_context',
    {
      title: 'Get Native Log Context',
      annotations: readOnlyAnnotations,
      description: 'Fetch chronological native log context around one previously returned log id. Use this after finding an error to understand what happened immediately before and after it.',
      inputSchema: {
        id: z.string().min(1).describe('Stable log id returned by search_native_logs or get_recent_native_errors'),
        before: z.number().int().min(0).max(100).optional().describe('Number of older records leading up to the target'),
        after: z.number().int().min(0).max(100).optional().describe('Number of newer records following the target')
      }
    },
    safeTool(async (input) => {
      const result = await client.logContext(input.id, {
        before: input.before ?? 20,
        after: input.after ?? 20
      });
      return toolSuccess(result, 'Chronological context around the selected native log.');
    })
  );

  server.registerTool(
    'get_recent_native_errors',
    {
      title: 'Get Recent Native Error Groups',
      annotations: readOnlyAnnotations,
      description: 'Group captured error/fatal/crash-signal logs by normalized signature. Use this to identify repeated native failures before drilling into a sample log id with get_native_log_context.',
      inputSchema: {
        scope: z.enum(['app', 'all']).optional(),
        process: z.string().optional(),
        package: z.string().optional(),
        service: z.string().optional(),
        text: z.string().optional(),
        lookback_ms: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(50).optional()
      }
    },
    safeTool(async (input) => {
      const result = await client.errorGroups({
        scope: input.scope || 'app',
        process: input.process,
        package: input.package,
        service: input.service,
        text: input.text,
        lookbackMs: input.lookback_ms,
        limit: input.limit || 20
      });
      return toolSuccess(result, 'Grouped native error evidence. crashSignal means the captured text matched a crash/fatal signal; it is not an invented diagnosis.');
    })
  );

  server.registerTool(
    'list_native_processes',
    {
      title: 'List Native Processes',
      annotations: readOnlyAnnotations,
      description: 'Returns observed simulator/device processes with host-side CPU/RAM metrics when available, merged with captured log counts. Useful for finding the main app, noisy daemons, and processes correlated with errors.',
      inputSchema: {}
    },
    safeTool(async () => {
      const [session, metrics, stats, observed] = await Promise.all([
        client.session(),
        client.processes(),
        client.stats(),
        client.processList()
      ]);
      const logCounts = stats?.processes || {};
      const primary = session?.app?.primaryProcess || null;
      const byKey = new Map();

      for (const item of observed || []) {
        const key = item?.pid ? `pid:${item.pid}` : `name:${item?.name || item?.process || 'unknown'}`;
        byKey.set(key, { ...item, process: item.process || item.name || null });
      }

      for (const metric of metrics || []) {
        const key = metric?.pid ? `pid:${metric.pid}` : `name:${metric?.process || 'unknown'}`;
        byKey.set(key, { ...(byKey.get(key) || {}), ...metric });
      }

      for (const [process, capturedLogs] of Object.entries(logCounts)) {
        const existingKey = [...byKey.keys()].find((key) => byKey.get(key)?.process === process || byKey.get(key)?.name === process);
        if (existingKey) {
          byKey.set(existingKey, { ...byKey.get(existingKey), capturedLogs });
        } else {
          byKey.set(`logs:${process}`, { process, capturedLogs });
        }
      }

      const rows = [...byKey.values()]
        .map((item) => ({
          ...item,
          process: item.process || item.name || 'Unknown',
          isMainApp: Boolean(item.isMainApp || (primary && (item.process === primary || item.name === primary))),
          capturedLogs: item.capturedLogs ?? logCounts[item.process || item.name] ?? 0
        }))
        .sort((a, b) =>
          Number(b.isMainApp) - Number(a.isMainApp) ||
          Number(b.capturedLogs || 0) - Number(a.capturedLogs || 0) ||
          Number(b.cpuPercent || 0) - Number(a.cpuPercent || 0)
        );

      return toolSuccess({
        primaryProcess: primary,
        processes: rows,
        totalObservedProcesses: rows.length
      });
    })
  );

  server.registerTool(
    'get_runtime_telemetry',
    {
      title: 'Get Runtime Telemetry',
      annotations: readOnlyAnnotations,
      description: 'Returns the latest real runtime/host telemetry for a process: memory, CPU, FPS, thread count, thermal state, battery, heap and traffic counters when that platform exposes them. Missing measurements remain absent/unavailable rather than being guessed.',
      inputSchema: {
        process: z.string().optional().describe('Process name. Omit to use the current app primary process.')
      }
    },
    safeTool(async (input) => {
      let processName = input.process || '';
      if (!processName) {
        const session = await client.session();
        processName = session?.app?.primaryProcess || '';
      }
      const [runtime, host] = await Promise.all([
        client.runtime(processName),
        processName ? client.metrics(processName).catch(() => ({ available: false })) : Promise.resolve({ available: false })
      ]);
      return toolSuccess({ process: processName || null, runtime, host });
    })
  );

  server.registerTool(
    'get_network_evidence',
    {
      title: 'Get Network Evidence',
      annotations: readOnlyAnnotations,
      description: 'Search captured native logs for real CFNetwork/Network.framework/OkHttp/TLS/QUIC/socket evidence. This is log-derived evidence, not a synthetic HTTP inspector; URL, endpoint, TLS version or protocol appear only when emitted by the native stack.',
      inputSchema: {
        scope: z.enum(['app', 'all']).optional(),
        text: z.string().optional(),
        process: z.string().optional(),
        levels: z.array(z.string()).optional(),
        lookback_ms: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional()
      }
    },
    safeTool(async (input) => {
      const result = await client.searchLogs({
        scope: input.scope || 'app',
        text: input.text,
        process: input.process,
        levels: input.levels,
        networkOnly: true,
        lookbackMs: input.lookback_ms,
        limit: input.limit || 100,
        order: 'desc'
      });
      return toolSuccess(result, 'Network-related native log evidence captured from the platform logging stream.');
    })
  );

  server.registerResource(
    'native-debugger-session',
    'rnnd://session',
    {
      title: 'React Native Native Debugger Session',
      description: 'Current app, device, collector, Metro, log statistics and runtime telemetry.',
      mimeType: 'application/json'
    },
    async (uri) => {
      const [session, stats] = await Promise.all([client.session(), client.stats()]);
      const runtime = await client.runtime(session?.app?.primaryProcess || '').catch(() => ({ available: false }));
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: jsonText({ session, stats, runtime })
        }]
      };
    }
  );

  server.registerResource(
    'native-debugger-errors',
    'rnnd://errors/recent',
    {
      title: 'Recent Native Error Groups',
      description: 'Current app-scoped grouped native errors and crash signals.',
      mimeType: 'application/json'
    },
    async (uri) => {
      const errors = await client.errorGroups({ scope: 'app', limit: 20 });
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: jsonText(errors)
        }]
      };
    }
  );

  server.registerResource(
    'native-debugger-runtime',
    'rnnd://runtime/main',
    {
      title: 'Main App Runtime Telemetry',
      description: 'Latest runtime telemetry for the current React Native app process.',
      mimeType: 'application/json'
    },
    async (uri) => {
      const session = await client.session();
      const processName = session?.app?.primaryProcess || '';
      const runtime = await client.runtime(processName);
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: jsonText({ process: processName, runtime })
        }]
      };
    }
  );

  server.registerPrompt(
    'diagnose-native-issue',
    {
      title: 'Diagnose a React Native Native Issue',
      description: 'Evidence-first workflow for diagnosing a React Native issue from live native logs and telemetry.',
      argsSchema: {
        symptom: z.string().optional().describe('What the developer observes, e.g. upload hangs after 300 MB'),
        scope: z.enum(['app', 'all']).optional().describe('Start with app unless the issue likely involves OS/network daemons')
      }
    },
    ({ symptom, scope }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            'Diagnose this React Native native/runtime issue using the connected React Native Native Debugger MCP server.',
            symptom ? `Observed symptom: ${symptom}` : 'Observed symptom: not specified; inspect the active error evidence first.',
            `Initial scope: ${scope || 'app'}.`,
            '',
            'Workflow:',
            '1. Call native_debugger_status first.',
            '2. Call get_recent_native_errors and identify the strongest error/crash groups.',
            '3. For relevant sample ids, call get_native_log_context to reconstruct the sequence around the failure.',
            '4. Use search_native_logs for package/service/process/source-specific evidence and get_network_evidence when networking is implicated.',
            '5. Use get_runtime_telemetry and list_native_processes when CPU, memory, FPS, process restarts, or resource pressure may matter.',
            '6. Separate observed evidence from inference. Quote log ids/timestamps/process/package when explaining the diagnosis.',
            '7. Do not invent stack frames, HTTP details, package attribution, or root causes that the captured evidence does not support.',
            '8. Finish with likely causes ordered by evidence strength and concrete next debugging/fix actions.'
          ].join('\n')
        }
      }]
    })
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, transport, client };
}

module.exports = { runMcp };
