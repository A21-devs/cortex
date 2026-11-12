/**
 * Sheet page routes → components (CORTEX-UX §3.4, §12.2). Readers are routed by ui/reader/Reader.tsx. Owner:
 * E12 (Read, Time, Agents, Sources, Guide, Runs, New entry), E9 (Chart), E6 (Change history).
 */
import type { FunctionComponent } from "preact";
import type { SheetPageRoute } from "../../shared/views";
import { AddSources } from "./AddSources";
import { Agents } from "./Agents";
import { ChangeHistory } from "./ChangeHistory";
import { ChartPage } from "./ChartPage";
import { Guide } from "./Guide";
import { NewEntry } from "./NewEntry";
import { Read } from "./Read";
import { RunsLedger } from "./RunsLedger";
import { Sources } from "./Sources";
import { Time } from "./Time";
import { You } from "./You";

export type PageProps = { params: Readonly<Record<string, string>> };

export const SHEET_PAGES: Readonly<Record<SheetPageRoute, FunctionComponent<PageProps>>> = {
  read: Read,
  time: Time,
  agents: Agents,
  sources: Sources,
  chart: ChartPage,
  guide: Guide,
  "new-entry": NewEntry,
  "change-history": ChangeHistory,
  runs: RunsLedger,
  you: You,
  add: AddSources,
};
