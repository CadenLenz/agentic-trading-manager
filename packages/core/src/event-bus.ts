import { EventEmitter } from 'node:events';
import { makeId, nowIso } from './utils.js';

export interface SystemEvent { id: string; type: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; source: string; strategyId?: string; symbol?: string; payload: Record<string, unknown>; createdAt: string }

export class EventBus extends EventEmitter {
  publish(input: Omit<SystemEvent, 'id' | 'createdAt'>): SystemEvent {
    const event: SystemEvent = { id: makeId('evt'), createdAt: nowIso(), ...input };
    this.emit('system-event', event);
    this.emit(input.type, event);
    return event;
  }
}
