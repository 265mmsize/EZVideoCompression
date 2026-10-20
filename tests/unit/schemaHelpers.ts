import { appSettingsSchema } from '../../src/shared/schemas/ipc.schemas';

export const AppSettingsSchemaCheck = {
  ok: (partial: Record<string, unknown>): boolean =>
    appSettingsSchema.partial().safeParse(partial).success,
};
