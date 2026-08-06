import type { CommunityPluginLocalBundleFact } from "./community-plugin-join";
import type {
  DeviceCommunityPluginParticipationCommand,
  DeviceCommunityPluginParticipationV1,
} from "./community-plugin-participation";

export function planCommunityPluginLocalReconciliation(input: Readonly<{
  participation: Readonly<DeviceCommunityPluginParticipationV1>;
  localBundleFacts: ReadonlyMap<string, CommunityPluginLocalBundleFact>;
  operationId: (pluginId: string) => string;
  autoParticipatePluginIds?: readonly string[];
}>): {
  commands: DeviceCommunityPluginParticipationCommand[];
  followUpPluginIds: string[];
  autoParticipatedPluginIds: string[];
} {
  const commands: DeviceCommunityPluginParticipationCommand[] = [];
  const followUpPluginIds: string[] = [];
  const autoParticipatedPluginIds: string[] = [];
  for (const entry of Object.values(input.participation.pluginsById).sort(
    (left, right) => left.pluginId.localeCompare(right.pluginId),
  )) {
    const local = input.localBundleFacts.get(entry.pluginId);
    if (!local) continue;
    if (entry.phase === "participating" && local === "absent") {
      commands.push({
        type: "request-exit",
        pluginId: entry.pluginId,
        operationId: input.operationId(entry.pluginId),
      });
      followUpPluginIds.push(entry.pluginId);
      continue;
    }
    if (entry.phase !== "exit-requested") continue;
    if (local === "absent") {
      commands.push({
        type: "confirm-excluded",
        pluginId: entry.pluginId,
      });
      continue;
    }
    commands.push({
      type: "confirm-participating",
      pluginId: entry.pluginId,
      joinedGeneration: entry.joinedGeneration,
      localBundleDigest: entry.lastConfirmedLocalBundleDigest,
    });
  }
  const commandedPluginIds = new Set(
    commands.map((command) => command.type === "set-scope-enabled"
      ? null
      : command.pluginId).filter((pluginId): pluginId is string =>
      pluginId !== null
    ),
  );
  for (const pluginId of [
    ...new Set(input.autoParticipatePluginIds ?? []),
  ].sort((left, right) => left.localeCompare(right))) {
    if (commandedPluginIds.has(pluginId)) continue;
    if (input.localBundleFacts.get(pluginId) !== "complete") continue;
    const existing = input.participation.pluginsById[pluginId];
    if (existing && existing.phase !== "never-participated") continue;
    commands.push({
      type: "confirm-participating",
      pluginId,
    });
    autoParticipatedPluginIds.push(pluginId);
    commandedPluginIds.add(pluginId);
  }
  return { commands, followUpPluginIds, autoParticipatedPluginIds };
}
