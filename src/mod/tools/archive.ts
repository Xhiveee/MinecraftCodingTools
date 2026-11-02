import { getCodeArchiveClass, inspectCodeArchive, searchCodeArchive, type CodeArchiveAdapter } from "../../common/code-archive-tools.js";
import type { Services } from "../services.js";
import type { McIndex } from "../index/store.js";
import type { CodeArchiveIndex } from "../../common/code-archive-tools.js";
import { findUsages } from "../index/xref.js";
import { findCallees } from "../index/browse.js";

const adapter = (services: Services): CodeArchiveAdapter<McIndex & CodeArchiveIndex> => ({
  open: (file, sources) => services.indexes.openArchive(file, sources),
  decompileMany: (index, outers) => services.indexes.decompileMany(index, outers),
  usages: (index, owner, member) => findUsages(index, { owner, member }),
  callees: (index, owner, name, desc) => findCallees(index, owner, name, desc),
});

export const inspectCodeArchiveTool = (services: Services, args: Parameters<typeof inspectCodeArchive>[0]) => inspectCodeArchive(args, adapter(services));
export const searchCodeArchiveTool = (services: Services, args: Parameters<typeof searchCodeArchive>[0]) => searchCodeArchive(args, adapter(services));
export const getCodeArchiveClassTool = (services: Services, args: Parameters<typeof getCodeArchiveClass>[0]) => getCodeArchiveClass(args, adapter(services));
