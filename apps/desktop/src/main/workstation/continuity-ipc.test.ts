/** Local continuity must not become a renderer route to execution or context changes mid-run. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { IpcMainInvokeEvent } from "electron";
import type { WorkstationProject, WorkstationSavedRoutine } from "@cadrane/contracts";
import { IPC_CHANNELS as C } from "../../shared/ipc-channels.js";
import { MIGRATIONS } from "../book/schema.js";
import { openCase, readCase, appendTurn, turnsFor } from "../book/cases.js";
import { installWorkstationContinuity } from "./continuity-ipc.js";

const fixture = vi.hoisted(() => ({ handlers: new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>() }));
vi.mock("electron", () => ({ ipcMain: { handle: (name: string, fn: (event: IpcMainInvokeEvent, input?: unknown) => unknown) => fixture.handlers.set(name, fn) } }));

let db: DatabaseSync;
const book = vi.fn(() => db);
let trusted = true;
const idle = vi.fn((_id: string) => {});
const event = {} as IpcMainInvokeEvent;
const invoke = (channel: string, input?: unknown) => fixture.handlers.get(channel)!(event, input);
const routine = {title: "Check the brief", description: "Find missing decisions.", prompt: "Read the selected brief and list unknowns.", icon: "review", sourceHint: "The current project brief", outputLabel: "A decision checklist"};

beforeEach(() => {
  vi.clearAllMocks(); fixture.handlers.clear(); trusted = true; idle.mockReset();
  db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  installWorkstationContinuity({book, assertTrusted: () => { if (!trusted) throw new Error("Untrusted renderer"); }, assertIdle: idle});
});
afterEach(() => db.close());

describe("continuity IPC authority", () => {
  it("refuses every continuity channel before touching the book for an untrusted document", () => {
    trusted = false;
    for (const channel of [C.workstationContinuity, C.workstationRenameWork, C.workstationProjectSave, C.workstationProjectAssign, C.workstationProjectCapture, C.workstationRoutineSave, C.workstationRoutineVersions]) {
      expect(() => invoke(channel, {})).toThrow("Untrusted renderer");
    }
    expect(book).not.toHaveBeenCalled(); expect(idle).not.toHaveBeenCalled();
  });
  it("rejects paths, execution grants, malformed revisions and unknown fields before mutation", () => {
    for (const [channel, input] of [
      [C.workstationProjectSave, {title: "Launch", brief: "Shared goal", folder: "/private"}],
      [C.workstationProjectSave, {title: "Launch", brief: "Shared goal", expectedRevision: 1}],
      [C.workstationProjectAssign, {caseId: "work", projectId: "/private"}],
      [C.workstationProjectCapture, {caseId: "work", expectedRevision: 1, allowAll: true}],
      [C.workstationRoutineSave, {...routine, tools: ["shell"], run: true}],
      [C.workstationRoutineSave, {...routine, expectedRevision: -1}],
      [C.workstationRoutineVersions, {id: "/private/history"}],
      [C.workstationRenameWork, {caseId: "work", title: "Changed", expectedTitle: "Original", prompt: "Rewrite the conversation"}],
    ] as const) expect(() => invoke(channel, input)).toThrow();
    expect(idle).not.toHaveBeenCalled();
    expect(invoke(C.workstationContinuity)).toEqual({projects: [], links: [], routines: []});
  });
  it("guards both assignment and capture while a task is active", () => {
    const project = invoke(C.workstationProjectSave, {title: "Launch", brief: "Exact source"}) as WorkstationProject;
    const work = openCase(db, {title: "A task", question: "Make the brief useful"});
    const caseId = work;
    idle.mockImplementation(() => { throw new Error("Task still running"); });
    expect(() => invoke(C.workstationProjectAssign, {caseId, projectId: project.id})).toThrow("Task still running");
    expect(() => invoke(C.workstationProjectCapture, {caseId, expectedRevision: 1})).toThrow("Task still running");
    expect(() => invoke(C.workstationRenameWork, {caseId, title: "Changed", expectedTitle: "A task"})).toThrow("Task still running");
    expect(idle).toHaveBeenCalledWith(caseId);
    expect(turnsFor(db, caseId)).toEqual([]);
    expect(invoke(C.workstationContinuity)).toMatchObject({links: []});
  });
  it("captures only the reviewed revision and returns persistent routine history without running it", () => {
    const project = invoke(C.workstationProjectSave, {title: "Launch", brief: "Shared goal v1"}) as WorkstationProject;
    const caseId = openCase(db, {title: "A task", question: "Plan the launch"});
    invoke(C.workstationProjectAssign, {caseId, projectId: project.id});
    invoke(C.workstationProjectCapture, {caseId, expectedRevision: 1});
    invoke(C.workstationProjectSave, {id: project.id, expectedRevision: 1, title: project.title, brief: "Shared goal v2"});
    expect(() => invoke(C.workstationProjectCapture, {caseId, expectedRevision: 1})).toThrow("expected revision 1");
    expect(turnsFor(db, caseId).map(turn => turn.body)).toEqual(["Shared goal v1"]);
    const saved = invoke(C.workstationRoutineSave, routine) as WorkstationSavedRoutine;
    invoke(C.workstationRoutineSave, {...routine, id: saved.id, expectedRevision: 1, prompt: "List unknowns and the next decision."});
    expect((invoke(C.workstationRoutineVersions, {id: saved.id}) as WorkstationSavedRoutine[]).map(value => value.prompt)).toEqual([routine.prompt, "List unknowns and the next decision."]);
    expect(turnsFor(db, caseId)).toHaveLength(1);
    expect(invoke(C.workstationContinuity)).toMatchObject({links: [{caseId, projectId: project.id}], projects: [{revision: 2}], routines: [{revision: 2}]});
  });
  it("renames only the task title and refuses a stale name without touching original evidence", () => {
    const caseId = openCase(db, {title: "Original", question: "The original question"});
    appendTurn(db, caseId, {seat: "owner", kind: "verbatim", body: "Original request text"});
    const before = turnsFor(db, caseId);
    invoke(C.workstationRenameWork, {caseId, title: "  Production checklist  ", expectedTitle: "Original"});
    expect(readCase(db, caseId)).toMatchObject({title: "Production checklist", question: "The original question"});
    expect(turnsFor(db, caseId)).toEqual(before);
    expect(() => invoke(C.workstationRenameWork, {caseId, title: "Old editor overwrites", expectedTitle: "Original"})).toThrow("changed");
    expect(readCase(db, caseId)?.title).toBe("Production checklist");
  });
});
