import { db } from "./db";
import type { Event, EventType } from "./generated/prisma/client";
import { EVENT_PAYLOAD_SCHEMAS, type EventTypeName } from "./schemas";

/**
 * The only way an Event row is written (§2). Validates the payload against the
 * per-type zod schema so the poll feed's shapes stay trustworthy forever.
 */
export async function emitEvent(
  taskId: string,
  type: EventType,
  payload: unknown,
  stageRunId?: string,
): Promise<Event> {
  const schema = EVENT_PAYLOAD_SCHEMAS[type as EventTypeName];
  const parsed = schema.parse(payload);
  return db.event.create({
    data: {
      taskId,
      type,
      payload: parsed,
      ...(stageRunId ? { stageRunId } : {}),
    },
  });
}
