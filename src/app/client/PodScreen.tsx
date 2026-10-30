/**
 * The pod screen: a Lambda's chat, its cards, its workflow, its terminals
 * and what it made. One module, loaded as its own chunk (App.tsx imports it
 * lazily), so the shell around it — sidebar, queue, pages — loads first.
 */
export { StalledCard, YourTurnCard } from './AttentionCards';
export { OldVersionNote, VersionMenu } from './CardVersions';
export { ChatPanel } from './ChatPanel';
export { PlanPlayer } from './PlanPlayer';
export { PodIdle } from './PodIdle';
export { MadeRail } from './Prototypes';
export { QuestionCard } from './QuestionCard';
export { StructureCard } from './StructureCard';
export { TerminalView } from './TerminalView';
export { WindowPicker } from './WindowPicker';
export { WorkflowPanel } from './WorkflowPanel';
