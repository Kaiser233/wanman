/**
 * wanman agents — list, spawn, and destroy agents
 *
 * Usage:
 *   wanman agents                          List all agents
 *   wanman agents spawn <template> [name]  Spawn a clone of <template>
 *   wanman agents destroy <name>           Destroy a dynamic clone
 */

import { RPC_METHODS } from '@wanman/core';
import { rpcCall } from '../transport.js';

interface AgentInfo {
  name: string;
  state: string;
  lifecycle: string;
  runtime?: string;
  model: string;
  currentTool?: string;
  totalTokens?: number;
  branch?: string;
  haltedReason?: string;
}

export async function agentsCommand(args?: string[]): Promise<void> {
  const subcommand = args?.[0]

  if (subcommand === 'spawn') {
    return agentSpawnCommand(args!.slice(1))
  }
  if (subcommand === 'destroy') {
    return agentDestroyCommand(args!.slice(1))
  }

  // Default: list agents
  const resp = await rpcCall(RPC_METHODS.AGENT_LIST);

  if (resp.error) {
    console.error(`Error: ${resp.error.message}`);
    process.exit(1);
  }

  const { agents } = resp.result as { agents: AgentInfo[] };

  if (agents.length === 0) {
    console.log('No agents configured.');
    return;
  }

  console.log('Agent Matrix:');
  console.log('─'.repeat(72));
  for (const agent of agents) {
    const stateIcon = agent.state === 'running' ? '*' : agent.state === 'idle' ? '-' : 'x';
    const runtimeModel = agent.runtime ? `${agent.runtime}/${agent.model}` : agent.model;
    const extras: string[] = [];
    if (agent.currentTool) extras.push(`tool:${agent.currentTool}`);
    if (agent.totalTokens && agent.totalTokens > 0) extras.push(`${agent.totalTokens} tok`);
    if (agent.branch) extras.push(`[${agent.branch}]`);
    if (agent.haltedReason) extras.push(`halted:${agent.haltedReason}`);
    const suffix = extras.length > 0 ? `  ${extras.join(' ')}` : '';
    console.log(`  ${stateIcon} ${agent.name.padEnd(15)} ${agent.state.padEnd(10)} ${agent.lifecycle.padEnd(11)} ${runtimeModel}${suffix}`);
  }
}

async function agentSpawnCommand(args: string[]): Promise<void> {
  const template = args[0]
  const name = args[1]

  if (!template) {
    console.error('Usage: wanman agents spawn <template> [name]')
    console.error('Example: wanman agents spawn feedback feedback-2')
    process.exit(1)
  }

  const resp = await rpcCall(RPC_METHODS.AGENT_SPAWN, { template, name })

  if (resp.error) {
    console.error(`Error: ${resp.error.message}`)
    process.exit(1)
  }

  const result = resp.result as { name: string }
  console.log(`Spawned: ${result.name} (clone of ${template})`)
}

async function agentDestroyCommand(args: string[]): Promise<void> {
  const name = args[0]

  if (!name) {
    console.error('Usage: wanman agents destroy <name>')
    process.exit(1)
  }

  const resp = await rpcCall(RPC_METHODS.AGENT_DESTROY, { name })

  if (resp.error) {
    console.error(`Error: ${resp.error.message}`)
    process.exit(1)
  }

  const result = resp.result as { destroyed: boolean }
  if (result.destroyed) {
    console.log(`Destroyed: ${name}`)
  } else {
    console.error(`Cannot destroy '${name}' — only dynamic agents can be destroyed`)
    process.exit(1)
  }
}
