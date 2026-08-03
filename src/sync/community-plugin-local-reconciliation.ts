import type { CommunityPluginLocalBundleFact } from "./community-plugin-join";
import type {
  DeviceCommunityPluginParticipationCommand,
  DeviceCommunityPluginParticipationV1,
} from "./community-plugin-participation";

export function planCommunityPluginLocalReconciliation(input: Readonly<{
  participation: Readonly<DeviceCommunityPluginParticipationV1>;
  localBundleFacts: ReadonlyMap<string, CommunityPluginLocalBundleFact>;
  operationId: (pluginId: string) => string;
}>): {
  commands: DeviceCommunityPluginParticipationCommand[];
  followUpPluginIds: string[];
} {
  const commands: DeviceCommunityPluginParticipationCommand[] = [];
  const followUpPluginIds: string[] = [];
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
  return { commands, followUpPluginIds };
}
