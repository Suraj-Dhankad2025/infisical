/* eslint-disable no-unreachable-loop */
/* eslint-disable no-await-in-loop */
import { ForbiddenError, subject } from "@casl/ability";

import { SecretEncryptionAlgo, SecretKeyEncoding, SecretsSchema, SecretType } from "@app/db/schemas";
import { TPermissionServiceFactory } from "@app/ee/services/permission/permission-service";
import { ProjectPermissionActions, ProjectPermissionSub } from "@app/ee/services/permission/project-permission";
import { TSecretSnapshotServiceFactory } from "@app/ee/services/secret-snapshot/secret-snapshot-service";
import { getConfig } from "@app/lib/config/env";
import { buildSecretBlindIndexFromName, encryptSymmetric128BitHexKeyUTF8 } from "@app/lib/crypto";
import { BadRequestError } from "@app/lib/errors";
import { groupBy, pick } from "@app/lib/fn";
import { logger } from "@app/lib/logger";

import { ActorType } from "../auth/auth-type";
import { TProjectDALFactory } from "../project/project-dal";
import { TProjectBotServiceFactory } from "../project-bot/project-bot-service";
import { TProjectEnvDALFactory } from "../project-env/project-env-dal";
import { TSecretBlindIndexDALFactory } from "../secret-blind-index/secret-blind-index-dal";
import { TSecretFolderDALFactory } from "../secret-folder/secret-folder-dal";
import { TSecretImportDALFactory } from "../secret-import/secret-import-dal";
import { fnSecretsFromImports } from "../secret-import/secret-import-fns";
import { TSecretTagDALFactory } from "../secret-tag/secret-tag-dal";
import { TSecretDALFactory } from "./secret-dal";
import {
  decryptSecretRaw,
  fnSecretBlindIndexCheck,
  fnSecretBulkInsert,
  fnSecretBulkUpdate,
  recursivelyGetSecretPaths
} from "./secret-fns";
import { TSecretQueueFactory } from "./secret-queue";
import {
  TAttachSecretTagsDTO,
  TCreateBulkSecretDTO,
  TCreateManySecretRawDTO,
  TCreateSecretDTO,
  TCreateSecretRawDTO,
  TDeleteBulkSecretDTO,
  TDeleteManySecretRawDTO,
  TDeleteSecretDTO,
  TDeleteSecretRawDTO,
  TFnSecretBlindIndexCheckV2,
  TFnSecretBulkDelete,
  TGetASecretDTO,
  TGetASecretRawDTO,
  TGetSecretsDTO,
  TGetSecretsRawDTO,
  TGetSecretVersionsDTO,
  TUpdateBulkSecretDTO,
  TUpdateManySecretRawDTO,
  TUpdateSecretDTO,
  TUpdateSecretRawDTO
} from "./secret-types";
import { TSecretVersionDALFactory } from "./secret-version-dal";
import { TSecretVersionTagDALFactory } from "./secret-version-tag-dal";

type TSecretServiceFactoryDep = {
  secretDAL: TSecretDALFactory;
  secretTagDAL: TSecretTagDALFactory;
  secretVersionDAL: TSecretVersionDALFactory;
  projectDAL: Pick<TProjectDALFactory, "checkProjectUpgradeStatus" | "findProjectBySlug">;
  projectEnvDAL: Pick<TProjectEnvDALFactory, "findOne">;
  folderDAL: Pick<
    TSecretFolderDALFactory,
    "findBySecretPath" | "updateById" | "findById" | "findByManySecretPath" | "find"
  >;
  secretBlindIndexDAL: TSecretBlindIndexDALFactory;
  permissionService: Pick<TPermissionServiceFactory, "getProjectPermission">;
  snapshotService: Pick<TSecretSnapshotServiceFactory, "performSnapshot">;
  secretQueueService: Pick<TSecretQueueFactory, "syncSecrets" | "handleSecretReminder" | "removeSecretReminder">;
  projectBotService: Pick<TProjectBotServiceFactory, "getBotKey">;
  secretImportDAL: Pick<TSecretImportDALFactory, "find" | "findByFolderIds">;
  secretVersionTagDAL: Pick<TSecretVersionTagDALFactory, "insertMany">;
};

export type TSecretServiceFactory = ReturnType<typeof secretServiceFactory>;
export const secretServiceFactory = ({
  secretDAL,
  projectEnvDAL,
  secretTagDAL,
  secretVersionDAL,
  folderDAL,
  secretBlindIndexDAL,
  permissionService,
  snapshotService,
  secretQueueService,
  projectDAL,
  projectBotService,
  secretImportDAL,
  secretVersionTagDAL
}: TSecretServiceFactoryDep) => {
  // utility function to get secret blind index data
  const interalGenSecBlindIndexByName = async (projectId: string, secretName: string) => {
    const appCfg = getConfig();

    const secretBlindIndexDoc = await secretBlindIndexDAL.findOne({ projectId });
    if (!secretBlindIndexDoc) throw new BadRequestError({ message: "Blind index not found", name: "Create secret" });

    const secretBlindIndex = await buildSecretBlindIndexFromName({
      secretName,
      keyEncoding: secretBlindIndexDoc.keyEncoding as SecretKeyEncoding,
      rootEncryptionKey: appCfg.ROOT_ENCRYPTION_KEY,
      encryptionKey: appCfg.ENCRYPTION_KEY,
      tag: secretBlindIndexDoc.saltTag,
      ciphertext: secretBlindIndexDoc.encryptedSaltCipherText,
      iv: secretBlindIndexDoc.saltIV
    });
    if (!secretBlindIndex) throw new BadRequestError({ message: "Secret not found" });
    return secretBlindIndex;
  };

  const fnSecretBulkDelete = async ({ folderId, inputSecrets, tx, actorId }: TFnSecretBulkDelete) => {
    const deletedSecrets = await secretDAL.deleteMany(
      inputSecrets.map(({ type, secretBlindIndex }) => ({
        blindIndex: secretBlindIndex,
        type
      })),
      folderId,
      actorId,
      tx
    );

    for (const s of deletedSecrets) {
      if (s.secretReminderRepeatDays) {
        // eslint-disable-next-line no-await-in-loop
        await secretQueueService
          .removeSecretReminder({
            secretId: s.id,
            repeatDays: s.secretReminderRepeatDays
          })
          .catch((err) => {
            logger.error(err, `Failed to delete secret reminder for secret with ID ${s?.id}`);
          });
      }
    }

    return deletedSecrets;
  };

  // this is used when secret blind index already exist
  // mainly for secret approval
  const fnSecretBlindIndexCheckV2 = async ({ inputSecrets, folderId, userId }: TFnSecretBlindIndexCheckV2) => {
    if (inputSecrets.some(({ type }) => type === SecretType.Personal) && !userId) {
      throw new BadRequestError({ message: "Missing user id for personal secret" });
    }
    const secrets = await secretDAL.findByBlindIndexes(
      folderId,
      inputSecrets.map(({ secretBlindIndex, type }) => ({
        blindIndex: secretBlindIndex,
        type: type || SecretType.Shared
      })),
      userId
    );
    const secsGroupedByBlindIndex = groupBy(secrets, (i) => i.secretBlindIndex as string);

    return { secsGroupedByBlindIndex, secrets };
  };

  const createSecret = async ({
    path,
    actor,
    actorId,
    actorOrgId,
    environment,
    actorAuthMethod,
    projectId,
    ...inputSecret
  }: TCreateSecretDTO) => {
    const { permission } = await permissionService.getProjectPermission(
      actor,
      actorId,
      projectId,
      actorAuthMethod,
      actorOrgId
    );
    ForbiddenError.from(permission).throwUnlessCan(
      ProjectPermissionActions.Create,
      subject(ProjectPermissionSub.Secrets, { environment, secretPath: path })
    );

    await projectDAL.checkProjectUpgradeStatus(projectId);

    const folder = await folderDAL.findBySecretPath(projectId, environment, path);
    if (!folder)
      throw new BadRequestError({
        message: "Folder not found for the given environment slug & secret path",
        name: "Create secret"
      });
    const folderId = folder.id;

    const blindIndexCfg = await secretBlindIndexDAL.findOne({ projectId });
    if (!blindIndexCfg) throw new BadRequestError({ message: "Blind index not found", name: "CreateSecret" });

    if (ActorType.USER !== actor && inputSecret.type === SecretType.Personal) {
      throw new BadRequestError({ message: "Must be user to create personal secret" });
    }

    const { keyName2BlindIndex } = await fnSecretBlindIndexCheck({
      inputSecrets: [{ secretName: inputSecret.secretName, type: inputSecret.type as SecretType }],
      folderId,
      isNew: true,
      userId: actorId,
      blindIndexCfg,
      secretDAL
    });

    // if user creating personal check its shared also exist
    if (inputSecret.type === SecretType.Personal) {
      const sharedExist = await secretDAL.findOne({
        secretBlindIndex: keyName2BlindIndex[inputSecret.secretName],
        folderId,
        type: SecretType.Shared
      });
      if (!sharedExist)
        throw new BadRequestError({
          message: "Failed to create personal secret override for no corresponding shared secret"
        });
    }

    // validate tags
    // fetch all tags and if not same count throw error meaning one was invalid tags
    const tags = inputSecret.tags ? await secretTagDAL.findManyTagsById(projectId, inputSecret.tags) : [];
    if ((inputSecret.tags || []).length !== tags.length) throw new BadRequestError({ message: "Tag not found" });

    const { secretName, type, ...el } = inputSecret;
    const secret = await secretDAL.transaction((tx) =>
      fnSecretBulkInsert({
        folderId,
        inputSecrets: [
          {
            version: 1,
            secretBlindIndex: keyName2BlindIndex[secretName],
            type,
            ...el,
            userId: inputSecret.type === SecretType.Personal ? actorId : null,
            algorithm: SecretEncryptionAlgo.AES_256_GCM,
            keyEncoding: SecretKeyEncoding.UTF8,
            tags: inputSecret.tags
          }
        ],
        secretDAL,
        secretVersionDAL,
        secretTagDAL,
        secretVersionTagDAL,
        tx
      })
    );

    await snapshotService.performSnapshot(folderId);
    await secretQueueService.syncSecrets({ secretPath: path, projectId, environment });
    // TODO(akhilmhdh-pg): licence check, posthog service and snapshot
    return { ...secret[0], environment, workspace: projectId, tags };
  };

  const updateSecret = async ({
    path,
    actor,
    actorId,
    actorOrgId,
    environment,
    actorAuthMethod,
    projectId,
    ...inputSecret
  }: TUpdateSecretDTO) => {
    const { permission } = await permissionService.getProjectPermission(
      actor,
      actorId,
      projectId,
      actorAuthMethod,
      actorOrgId
    );
    ForbiddenError.from(permission).throwUnlessCan(
      ProjectPermissionActions.Edit,
      subject(ProjectPermissionSub.Secrets, { environment, secretPath: path })
    );

    await projectDAL.checkProjectUpgradeStatus(projectId);

    if (inputSecret.newSecretName === "") {
      throw new BadRequestError({ message: "New secret name cannot be empty" });
    }

    const folder = await folderDAL.findBySecretPath(projectId, environment, path);
    if (!folder)
      throw new BadRequestError({
        message: "Folder not found for the given environment slug & secret path",
        name: "Create secret"
      });
    const folderId = folder.id;

    const blindIndexCfg = await secretBlindIndexDAL.findOne({ projectId });
    if (!blindIndexCfg) throw new BadRequestError({ message: "Blind index not found", name: "CreateSecret" });

    if (ActorType.USER !== actor && inputSecret.type === SecretType.Personal) {
      throw new BadRequestError({ message: "Must be user to create personal secret" });
    }

    const { secrets, keyName2BlindIndex } = await fnSecretBlindIndexCheck({
      inputSecrets: [{ secretName: inputSecret.secretName, type: inputSecret.type as SecretType }],
      folderId,
      isNew: false,
      blindIndexCfg,
      userId: actorId,
      secretDAL
    });
    if (inputSecret.newSecretName && inputSecret.type === SecretType.Personal) {
      throw new BadRequestError({ message: "Personal secret cannot change the key name" });
    }

    let newSecretNameBlindIndex: string | undefined;
    if (inputSecret?.newSecretName) {
      const { keyName2BlindIndex: kN2NewBlindIndex } = await fnSecretBlindIndexCheck({
        inputSecrets: [{ secretName: inputSecret.newSecretName }],
        folderId,
        isNew: true,
        blindIndexCfg,
        secretDAL
      });
      newSecretNameBlindIndex = kN2NewBlindIndex[inputSecret.newSecretName];
    }

    await secretQueueService.handleSecretReminder({
      newSecret: {
        id: secrets[0].id,
        ...inputSecret
      },
      oldSecret: secrets[0],
      projectId
    });

    const tags = inputSecret.tags ? await secretTagDAL.findManyTagsById(projectId, inputSecret.tags) : [];
    if ((inputSecret.tags || []).length !== tags.length) throw new BadRequestError({ message: "Tag not found" });

    const { secretName, ...el } = inputSecret;

    const updatedSecret = await secretDAL.transaction(async (tx) =>
      fnSecretBulkUpdate({
        folderId,
        projectId,
        inputSecrets: [
          {
            filter: { id: secrets[0].id },
            data: {
              ...pick(el, [
                "type",
                "secretCommentCiphertext",
                "secretCommentTag",
                "secretCommentIV",
                "secretValueIV",
                "secretValueTag",
                "secretValueCiphertext",
                "secretKeyCiphertext",
                "secretKeyTag",
                "secretKeyIV",
                "metadata",
                "skipMultilineEncoding",
                "secretReminderNote",
                "secretReminderRepeatDays",
                "tags"
              ]),
              secretBlindIndex: newSecretNameBlindIndex || keyName2BlindIndex[secretName]
            }
          }
        ],
        secretDAL,
        secretVersionDAL,
        secretTagDAL,
        secretVersionTagDAL,
        tx
      })
    );

    await snapshotService.performSnapshot(folderId);
    await secretQueueService.syncSecrets({ secretPath: path, projectId, environment });
    // TODO(akhilmhdh-pg): licence check, posthog service and snapshot
    return { ...updatedSecret[0], workspace: projectId, environment };
  };

  const deleteSecret = async ({
    path,
    actor,
    actorId,
    actorOrgId,
    actorAuthMethod,
    environment,
    projectId,
    ...inputSecret
  }: TDeleteSecretDTO) => {
    const { permission } = await permissionService.getProjectPermission(
      actor,
      actorId,
      projectId,
      actorAuthMethod,
      actorOrgId
    );
    ForbiddenError.from(permission).throwUnlessCan(
      ProjectPermissionActions.Delete,
      subject(ProjectPermissionSub.Secrets, { environment, secretPath: path })
    );

    await projectDAL.checkProjectUpgradeStatus(projectId);

    const folder = await folderDAL.findBySecretPath(projectId, environment, path);
    if (!folder)
      throw new BadRequestError({
        message: "Folder not found for the given environment slug & secret path",
        name: "Create secret"
      });
    const folderId = folder.id;

    const blindIndexCfg = await secretBlindIndexDAL.findOne({ projectId });
    if (!blindIndexCfg) throw new BadRequestError({ message: "Blind index not found", name: "CreateSecret" });

    if (ActorType.USER !== actor && inputSecret.type === SecretType.Personal) {
      throw new BadRequestError({ message: "Must be user to create personal secret" });
    }

    const { keyName2BlindIndex } = await fnSecretBlindIndexCheck({
      inputSecrets: [{ secretName: inputSecret.secretName }],
      folderId,
      isNew: false,
      blindIndexCfg,
      secretDAL
    });

    const deletedSecret = await secretDAL.transaction(async (tx) =>
      fnSecretBulkDelete({
        projectId,
        folderId,
        actorId,
        inputSecrets: [
          {
            type: inputSecret.type as SecretType,
            secretBlindIndex: keyName2BlindIndex[inputSecret.secretName]
          }
        ],
        tx
      })
    );

    await snapshotService.performSnapshot(folderId);
    await secretQueueService.syncSecrets({ secretPath: path, projectId, environment });

    // TODO(akhilmhdh-pg): licence check, posthog service and snapshot
    return { ...deletedSecret[0], _id: deletedSecret[0].id, workspace: projectId, environment };
  };

  const getSecrets = async ({
    actorId,
    path,
    environment,
    projectId,
    actor,
    actorOrgId,
    actorAuthMethod,
    includeImports,
    recursive
  }: TGetSecretsDTO) => {
    const { permission } = await permissionService.getProjectPermission(
      actor,
      actorId,
      projectId,
      actorAuthMethod,
      actorOrgId
    );

    let paths: { folderId: string; path: string }[] = [];

    if (recursive) {
      const getPaths = recursivelyGetSecretPaths({
        permissionService,
        folderDAL,
        projectEnvDAL
      });

      const deepPaths = await getPaths({
        projectId,
        environment,
        currentPath: path,
        auth: {
          actor,
          actorId,
          actorAuthMethod,
          actorOrgId
        }
      });

      if (!deepPaths) return { secrets: [], imports: [] };

      paths = deepPaths.map(({ folderId, path: p }) => ({ folderId, path: p }));
    } else {
      ForbiddenError.from(permission).throwUnlessCan(
        ProjectPermissionActions.Read,
        subject(ProjectPermissionSub.Secrets, { environment, secretPath: path })
      );

      const folder = await folderDAL.findBySecretPath(projectId, environment, path);
      if (!folder) return { secrets: [], imports: [] };

      paths = [{ folderId: folder.id, path }];
    }

    const groupedPaths = groupBy(paths, (p) => p.folderId);

    const secrets = await secretDAL.findByFolderIds(
      paths.map((p) => p.folderId),
      actorId
    );

    if (includeImports) {
      const secretImports = await secretImportDAL.findByFolderIds(paths.map((p) => p.folderId));
      const allowedImports = secretImports.filter(({ importEnv, importPath }) =>
        // if its service token allow full access over imported one
        actor === ActorType.SERVICE
          ? true
          : permission.can(
              ProjectPermissionActions.Read,
              subject(ProjectPermissionSub.Secrets, {
                environment: importEnv.slug,
                secretPath: importPath
              })
            )
      );
      const importedSecrets = await fnSecretsFromImports({
        allowedImports,
        secretDAL,
        folderDAL
      });

      return {
        secrets: secrets.map((secret) => ({
          ...secret,
          workspace: projectId,
          environment,
          secretPath: groupedPaths[secret.folderId][0].path
        })),
        imports: importedSecrets
      };
    }

    return {
      secrets: secrets.map((secret) => ({
        ...secret,
        workspace: projectId,
        environment,
        secretPath: groupedPaths[secret.folderId][0].path
      }))
    };
  };

  const getSecretByName = async ({
    actorId,
    actor,
    actorOrgId,
    actorAuthMethod,
    projectId,
    environment,
    path,
    type,
    secretName,
    version,
    includeImports
  }: TGetASecretDTO) => {
    const { permission } = await permissionService.getProjectPermission(
      actor,
      actorId,
      projectId,
      actorAuthMethod,
      actorOrgId
    );
    ForbiddenError.from(permission).throwUnlessCan(
      ProjectPermissionActions.Read,
      subject(ProjectPermissionSub.Secrets, { environment, secretPath: path })
    );
    const folder = await folderDAL.findBySecretPath(projectId, environment, path);
    if (!folder)
      throw new BadRequestError({
        message: "Folder not found for the given environment slug & secret path",
        name: "Create secret"
      });
    const folderId = folder.id;

    const secretBlindIndex = await interalGenSecBlindIndexByName(projectId, secretName);

    // Case: The old python SDK uses incorrect logic https://github.com/Infisical/infisical-python/blob/main/infisical/client/infisicalclient.py#L89.
    // Fetch secrets using service tokens cannot fetch personal secrets, only shared.
    // The mongo backend used to correct this mistake, this line also adds it to current backend
    // Mongo backend check: https://github.com/Infisical/infisical-mongo/blob/main/backend/src/helpers/secrets.ts#L658
    let secretType = type;
    if (actor === ActorType.SERVICE) {
      logger.info(
        `secretServiceFactory: overriding secret type for service token [projectId=${projectId}] [factoryFunctionName=getSecretByName]`
      );
      secretType = SecretType.Shared;
    }

    const secret = await (version === undefined
      ? secretDAL.findOne({
          folderId,
          type: secretType,
          userId: secretType === SecretType.Personal ? actorId : null,
          secretBlindIndex
        })
      : secretVersionDAL
          .findOne({
            folderId,
            type: secretType,
            userId: secretType === SecretType.Personal ? actorId : null,
            secretBlindIndex
          })
          .then((el) => SecretsSchema.parse({ ...el, id: el.secretId })));
    // now if secret is not found
    // then search for imported secrets
    // here we consider the import order also thus starting from bottom
    if (!secret && includeImports) {
      const secretImports = await secretImportDAL.find({ folderId });
      const allowedImports = secretImports.filter(({ importEnv, importPath }) =>
        // if its service token allow full access over imported one
        actor === ActorType.SERVICE
          ? true
          : permission.can(
              ProjectPermissionActions.Read,
              subject(ProjectPermissionSub.Secrets, {
                environment: importEnv.slug,
                secretPath: importPath
              })
            )
      );
      const importedSecrets = await fnSecretsFromImports({
        allowedImports,
        secretDAL,
        folderDAL
      });
      for (let i = importedSecrets.length - 1; i >= 0; i -= 1) {
        for (let j = 0; j < importedSecrets[i].secrets.length; j += 1) {
          if (secretBlindIndex === importedSecrets[i].secrets[j].secretBlindIndex) {
            return {
              ...importedSecrets[i].secrets[j],
              workspace: projectId,
              environment: importedSecrets[i].environment
            };
          }
        }
      }
    }
    if (!secret) throw new BadRequestError({ message: "Secret not found" });

    return { ...secret, workspace: projectId, environment };
  };

  const createManySecret = async ({
    path,
    actor,
    actorId,
    actorAuthMethod,
    actorOrgId,
    environment,
    projectId,
    secrets: inputSecrets
  }: TCreateBulkSecretDTO) => {
    const { permission } = await permissionService.getProjectPermission(
      actor,
      actorId,
      projectId,
      actorAuthMethod,
      actorOrgId
    );
    ForbiddenError.from(permission).throwUnlessCan(
      ProjectPermissionActions.Create,
      subject(ProjectPermissionSub.Secrets, { environment, secretPath: path })
    );

    await projectDAL.checkProjectUpgradeStatus(projectId);

    const folder = await folderDAL.findBySecretPath(projectId, environment, path);
    if (!folder)
      throw new BadRequestError({
        message: "Folder not found for the given environment slug & secret path",
        name: "Create secret"
      });
    const folderId = folder.id;

    const blindIndexCfg = await secretBlindIndexDAL.findOne({ projectId });
    if (!blindIndexCfg) throw new BadRequestError({ message: "Blind index not found", name: "Create secret" });

    const { keyName2BlindIndex } = await fnSecretBlindIndexCheck({
      inputSecrets,
      folderId,
      isNew: true,
      blindIndexCfg,
      secretDAL
    });

    // get all tags
    const tagIds = inputSecrets.flatMap(({ tags = [] }) => tags);
    const tags = tagIds.length ? await secretTagDAL.findManyTagsById(projectId, tagIds) : [];
    if (tags.length !== tagIds.length) throw new BadRequestError({ message: "Tag not found" });

    const newSecrets = await secretDAL.transaction(async (tx) =>
      fnSecretBulkInsert({
        inputSecrets: inputSecrets.map(({ secretName, ...el }) => ({
          ...el,
          version: 0,
          secretBlindIndex: keyName2BlindIndex[secretName],
          type: SecretType.Shared,
          algorithm: SecretEncryptionAlgo.AES_256_GCM,
          keyEncoding: SecretKeyEncoding.UTF8
        })),
        folderId,
        secretDAL,
        secretVersionDAL,
        secretTagDAL,
        secretVersionTagDAL,
        tx
      })
    );

    await snapshotService.performSnapshot(folderId);
    await secretQueueService.syncSecrets({ secretPath: path, projectId, environment });

    return newSecrets;
  };

  const updateManySecret = async ({
    path,
    actor,
    actorId,
    actorOrgId,
    actorAuthMethod,
    environment,
    projectId,
    secrets: inputSecrets
  }: TUpdateBulkSecretDTO) => {
    const { permission } = await permissionService.getProjectPermission(
      actor,
      actorId,
      projectId,
      actorAuthMethod,
      actorOrgId
    );
    ForbiddenError.from(permission).throwUnlessCan(
      ProjectPermissionActions.Edit,
      subject(ProjectPermissionSub.Secrets, { environment, secretPath: path })
    );

    await projectDAL.checkProjectUpgradeStatus(projectId);

    const folder = await folderDAL.findBySecretPath(projectId, environment, path);
    if (!folder)
      throw new BadRequestError({
        message: "Folder not found for the given environment slug & secret path",
        name: "Update secret"
      });
    const folderId = folder.id;

    const blindIndexCfg = await secretBlindIndexDAL.findOne({ projectId });
    if (!blindIndexCfg) throw new BadRequestError({ message: "Blind index not found", name: "Update secret" });

    const { keyName2BlindIndex } = await fnSecretBlindIndexCheck({
      inputSecrets,
      folderId,
      isNew: false,
      blindIndexCfg,
      secretDAL
    });

    // now find any secret that needs to update its name
    // same process as above
    const nameUpdatedSecrets = inputSecrets.filter(({ newSecretName }) => Boolean(newSecretName));
    const { keyName2BlindIndex: newKeyName2BlindIndex } = await fnSecretBlindIndexCheck({
      inputSecrets: nameUpdatedSecrets,
      folderId,
      isNew: true,
      blindIndexCfg,
      secretDAL
    });

    // get all tags
    const tagIds = inputSecrets.flatMap(({ tags = [] }) => tags);
    const tags = tagIds.length ? await secretTagDAL.findManyTagsById(projectId, tagIds) : [];
    if (tagIds.length !== tags.length) throw new BadRequestError({ message: "Tag not found" });
    const secrets = await secretDAL.transaction(async (tx) =>
      fnSecretBulkUpdate({
        folderId,
        projectId,
        tx,
        inputSecrets: inputSecrets.map(({ secretName, newSecretName, ...el }) => ({
          filter: { secretBlindIndex: keyName2BlindIndex[secretName], type: SecretType.Shared },
          data: {
            ...el,
            folderId,
            type: SecretType.Shared,
            secretBlindIndex:
              newSecretName && newKeyName2BlindIndex[newSecretName]
                ? newKeyName2BlindIndex[newSecretName]
                : keyName2BlindIndex[secretName],
            algorithm: SecretEncryptionAlgo.AES_256_GCM,
            keyEncoding: SecretKeyEncoding.UTF8
          }
        })),
        secretDAL,
        secretVersionDAL,
        secretTagDAL,
        secretVersionTagDAL
      })
    );

    await snapshotService.performSnapshot(folderId);
    await secretQueueService.syncSecrets({ secretPath: path, projectId, environment });

    return secrets;
  };

  const deleteManySecret = async ({
    secrets: inputSecrets,
    path,
    environment,
    projectId,
    actor,
    actorId,
    actorAuthMethod,
    actorOrgId
  }: TDeleteBulkSecretDTO) => {
    const { permission } = await permissionService.getProjectPermission(
      actor,
      actorId,
      projectId,
      actorAuthMethod,
      actorOrgId
    );
    ForbiddenError.from(permission).throwUnlessCan(
      ProjectPermissionActions.Delete,
      subject(ProjectPermissionSub.Secrets, { environment, secretPath: path })
    );

    await projectDAL.checkProjectUpgradeStatus(projectId);

    const folder = await folderDAL.findBySecretPath(projectId, environment, path);
    if (!folder)
      throw new BadRequestError({
        message: "Folder not found for the given environment slug & secret path",
        name: "Create secret"
      });
    const folderId = folder.id;

    const blindIndexCfg = await secretBlindIndexDAL.findOne({ projectId });
    if (!blindIndexCfg) throw new BadRequestError({ message: "Blind index not found", name: "Update secret" });

    const { keyName2BlindIndex } = await fnSecretBlindIndexCheck({
      inputSecrets,
      folderId,
      isNew: false,
      blindIndexCfg,
      secretDAL
    });

    const secretsDeleted = await secretDAL.transaction(async (tx) =>
      fnSecretBulkDelete({
        inputSecrets: inputSecrets.map(({ type, secretName }) => ({
          secretBlindIndex: keyName2BlindIndex[secretName],
          type
        })),
        projectId,
        folderId,
        actorId,
        tx
      })
    );

    await snapshotService.performSnapshot(folderId);
    await secretQueueService.syncSecrets({ secretPath: path, projectId, environment });

    return secretsDeleted;
  };

  const getSecretsRaw = async ({
    projectId,
    path,
    actor,
    actorId,
    actorOrgId,
    actorAuthMethod,
    environment,
    includeImports,
    recursive
  }: TGetSecretsRawDTO) => {
    const botKey = await projectBotService.getBotKey(projectId);
    if (!botKey) throw new BadRequestError({ message: "Project bot not found", name: "bot_not_found_error" });

    const { secrets, imports } = await getSecrets({
      actorId,
      projectId,
      environment,
      actor,
      actorOrgId,
      actorAuthMethod,
      path,
      includeImports,
      recursive
    });

    return {
      secrets: secrets.map((el) => decryptSecretRaw(el, botKey)),
      imports: (imports || [])?.map(({ secrets: importedSecrets, ...el }) => ({
        ...el,
        secrets: importedSecrets.map((sec) =>
          decryptSecretRaw(
            { ...sec, environment: el.environment, workspace: projectId, secretPath: el.secretPath },
            botKey
          )
        )
      }))
    };
  };

  const getSecretByNameRaw = async ({
    type,
    path,
    actor,
    environment,
    projectId,
    actorId,
    actorOrgId,
    actorAuthMethod,
    secretName,
    includeImports,
    version
  }: TGetASecretRawDTO) => {
    const botKey = await projectBotService.getBotKey(projectId);
    if (!botKey) throw new BadRequestError({ message: "Project bot not found", name: "bot_not_found_error" });

    const secret = await getSecretByName({
      actorId,
      projectId,
      actorAuthMethod,
      environment,
      actor,
      actorOrgId,
      path,
      secretName,
      type,
      includeImports,
      version
    });
    return decryptSecretRaw(secret, botKey);
  };

  const createSecretRaw = async ({
    secretName,
    actorId,
    projectId,
    environment,
    actor,
    actorOrgId,
    actorAuthMethod,
    type,
    secretPath,
    secretValue,
    secretComment,
    skipMultilineEncoding
  }: TCreateSecretRawDTO) => {
    const botKey = await projectBotService.getBotKey(projectId);
    if (!botKey) throw new BadRequestError({ message: "Project bot not found", name: "bot_not_found_error" });

    const secretKeyEncrypted = encryptSymmetric128BitHexKeyUTF8(secretName, botKey);
    const secretValueEncrypted = encryptSymmetric128BitHexKeyUTF8(secretValue || "", botKey);
    const secretCommentEncrypted = encryptSymmetric128BitHexKeyUTF8(secretComment || "", botKey);

    const secret = await createSecret({
      secretName,
      projectId,
      environment,
      type,
      path: secretPath,
      actor,
      actorId,
      actorAuthMethod,
      actorOrgId,
      secretKeyCiphertext: secretKeyEncrypted.ciphertext,
      secretKeyIV: secretKeyEncrypted.iv,
      secretKeyTag: secretKeyEncrypted.tag,
      secretValueCiphertext: secretValueEncrypted.ciphertext,
      secretValueIV: secretValueEncrypted.iv,
      secretValueTag: secretValueEncrypted.tag,
      secretCommentCiphertext: secretCommentEncrypted.ciphertext,
      secretCommentIV: secretCommentEncrypted.iv,
      secretCommentTag: secretCommentEncrypted.tag,
      skipMultilineEncoding
    });

    await snapshotService.performSnapshot(secret.folderId);
    await secretQueueService.syncSecrets({ secretPath, projectId, environment });

    return decryptSecretRaw(secret, botKey);
  };

  const updateSecretRaw = async ({
    secretName,
    actorId,
    projectId,
    environment,
    actor,
    actorOrgId,
    actorAuthMethod,
    type,
    secretPath,
    secretValue,
    skipMultilineEncoding
  }: TUpdateSecretRawDTO) => {
    const botKey = await projectBotService.getBotKey(projectId);
    if (!botKey) throw new BadRequestError({ message: "Project bot not found", name: "bot_not_found_error" });

    const secretValueEncrypted = encryptSymmetric128BitHexKeyUTF8(secretValue || "", botKey);

    const secret = await updateSecret({
      secretName,
      projectId,
      environment,
      type,
      path: secretPath,
      actor,
      actorId,
      actorOrgId,
      actorAuthMethod,
      secretValueCiphertext: secretValueEncrypted.ciphertext,
      secretValueIV: secretValueEncrypted.iv,
      secretValueTag: secretValueEncrypted.tag,
      skipMultilineEncoding
    });

    await snapshotService.performSnapshot(secret.folderId);
    await secretQueueService.syncSecrets({ secretPath, projectId, environment });

    return decryptSecretRaw(secret, botKey);
  };

  const deleteSecretRaw = async ({
    secretName,
    actorId,
    projectId,
    environment,
    actor,
    actorOrgId,
    actorAuthMethod,
    type,
    secretPath
  }: TDeleteSecretRawDTO) => {
    const botKey = await projectBotService.getBotKey(projectId);
    if (!botKey) throw new BadRequestError({ message: "Project bot not found", name: "bot_not_found_error" });

    const secret = await deleteSecret({
      secretName,
      projectId,
      environment,
      type,
      path: secretPath,
      actor,
      actorId,
      actorOrgId,
      actorAuthMethod
    });

    await snapshotService.performSnapshot(secret.folderId);
    await secretQueueService.syncSecrets({ secretPath, projectId, environment });

    return decryptSecretRaw(secret, botKey);
  };

  const createManySecretsRaw = async ({
    actorId,
    projectSlug,
    environment,
    actor,
    actorOrgId,
    actorAuthMethod,
    secretPath,
    secrets: inputSecrets = []
  }: TCreateManySecretRawDTO) => {
    const project = await projectDAL.findProjectBySlug(projectSlug, actorOrgId);
    if (!project) throw new BadRequestError({ message: "Project not found" });
    const projectId = project.id;

    const botKey = await projectBotService.getBotKey(projectId);
    if (!botKey) throw new BadRequestError({ message: "Project bot not found", name: "bot_not_found_error" });

    const secrets = await createManySecret({
      projectId,
      environment,
      path: secretPath,
      actor,
      actorId,
      actorOrgId,
      actorAuthMethod,
      secrets: inputSecrets.map(({ secretComment, secretKey, secretValue, skipMultilineEncoding }) => {
        const secretKeyEncrypted = encryptSymmetric128BitHexKeyUTF8(secretKey, botKey);
        const secretValueEncrypted = encryptSymmetric128BitHexKeyUTF8(secretValue || "", botKey);
        const secretCommentEncrypted = encryptSymmetric128BitHexKeyUTF8(secretComment || "", botKey);
        return {
          secretName: secretKey,
          skipMultilineEncoding,
          secretKeyCiphertext: secretKeyEncrypted.ciphertext,
          secretKeyIV: secretKeyEncrypted.iv,
          secretKeyTag: secretKeyEncrypted.tag,
          secretValueCiphertext: secretValueEncrypted.ciphertext,
          secretValueIV: secretValueEncrypted.iv,
          secretValueTag: secretValueEncrypted.tag,
          secretCommentCiphertext: secretCommentEncrypted.ciphertext,
          secretCommentIV: secretCommentEncrypted.iv,
          secretCommentTag: secretCommentEncrypted.tag
        };
      })
    });

    await snapshotService.performSnapshot(secrets[0].folderId);
    await secretQueueService.syncSecrets({ secretPath, projectId, environment });

    return secrets.map((secret) => decryptSecretRaw({ ...secret, workspace: projectId, environment }, botKey));
  };

  const updateManySecretsRaw = async ({
    actorId,
    projectSlug,
    environment,
    actor,
    actorOrgId,
    actorAuthMethod,
    secretPath,
    secrets: inputSecrets = []
  }: TUpdateManySecretRawDTO) => {
    const project = await projectDAL.findProjectBySlug(projectSlug, actorOrgId);
    if (!project) throw new BadRequestError({ message: "Project not found" });
    const projectId = project.id;

    const botKey = await projectBotService.getBotKey(projectId);
    if (!botKey) throw new BadRequestError({ message: "Project bot not found", name: "bot_not_found_error" });

    const secrets = await updateManySecret({
      projectId,
      environment,
      path: secretPath,
      actor,
      actorId,
      actorOrgId,
      actorAuthMethod,
      secrets: inputSecrets.map(({ secretComment, secretKey, secretValue, skipMultilineEncoding }) => {
        const secretKeyEncrypted = encryptSymmetric128BitHexKeyUTF8(secretKey, botKey);
        const secretValueEncrypted = encryptSymmetric128BitHexKeyUTF8(secretValue || "", botKey);
        const secretCommentEncrypted = encryptSymmetric128BitHexKeyUTF8(secretComment || "", botKey);
        return {
          secretName: secretKey,
          type: SecretType.Shared,
          skipMultilineEncoding,
          secretKeyCiphertext: secretKeyEncrypted.ciphertext,
          secretKeyIV: secretKeyEncrypted.iv,
          secretKeyTag: secretKeyEncrypted.tag,
          secretValueCiphertext: secretValueEncrypted.ciphertext,
          secretValueIV: secretValueEncrypted.iv,
          secretValueTag: secretValueEncrypted.tag,
          secretCommentCiphertext: secretCommentEncrypted.ciphertext,
          secretCommentIV: secretCommentEncrypted.iv,
          secretCommentTag: secretCommentEncrypted.tag
        };
      })
    });

    await snapshotService.performSnapshot(secrets[0].folderId);
    await secretQueueService.syncSecrets({ secretPath, projectId, environment });

    return secrets.map((secret) => decryptSecretRaw({ ...secret, workspace: projectId, environment }, botKey));
  };

  const deleteManySecretsRaw = async ({
    actorId,
    projectSlug,
    environment,
    actor,
    actorOrgId,
    actorAuthMethod,
    secretPath,
    secrets: inputSecrets = []
  }: TDeleteManySecretRawDTO) => {
    const project = await projectDAL.findProjectBySlug(projectSlug, actorOrgId);
    if (!project) throw new BadRequestError({ message: "Project not found" });
    const projectId = project.id;

    const botKey = await projectBotService.getBotKey(projectId);
    if (!botKey) throw new BadRequestError({ message: "Project bot not found", name: "bot_not_found_error" });

    const secrets = await deleteManySecret({
      projectId,
      environment,
      path: secretPath,
      actor,
      actorId,
      actorOrgId,
      actorAuthMethod,
      secrets: inputSecrets.map(({ secretKey }) => ({ secretName: secretKey, type: SecretType.Shared }))
    });

    await snapshotService.performSnapshot(secrets[0].folderId);
    await secretQueueService.syncSecrets({ secretPath, projectId, environment });

    return secrets.map((secret) => decryptSecretRaw({ ...secret, workspace: projectId, environment }, botKey));
  };

  const getSecretVersions = async ({
    actorId,
    actor,
    actorOrgId,
    actorAuthMethod,
    limit = 20,
    offset = 0,
    secretId
  }: TGetSecretVersionsDTO) => {
    const secret = await secretDAL.findById(secretId);
    if (!secret) throw new BadRequestError({ message: "Failed to find secret" });

    const folder = await folderDAL.findById(secret.folderId);
    if (!folder) throw new BadRequestError({ message: "Failed to find secret" });

    const { permission } = await permissionService.getProjectPermission(
      actor,
      actorId,
      folder.projectId,
      actorAuthMethod,
      actorOrgId
    );
    ForbiddenError.from(permission).throwUnlessCan(ProjectPermissionActions.Read, ProjectPermissionSub.SecretRollback);

    const secretVersions = await secretVersionDAL.find({ secretId }, { offset, limit, sort: [["createdAt", "desc"]] });
    return secretVersions;
  };

  const attachTags = async ({
    secretName,
    tagSlugs,
    path: secretPath,
    environment,
    type,
    projectSlug,
    actor,
    actorAuthMethod,
    actorOrgId,
    actorId
  }: TAttachSecretTagsDTO) => {
    const project = await projectDAL.findProjectBySlug(projectSlug, actorOrgId);

    const { permission } = await permissionService.getProjectPermission(
      actor,
      actorId,
      project.id,
      actorAuthMethod,
      actorOrgId
    );

    ForbiddenError.from(permission).throwUnlessCan(
      ProjectPermissionActions.Edit,
      subject(ProjectPermissionSub.Secrets, { environment, secretPath })
    );

    await projectDAL.checkProjectUpgradeStatus(project.id);

    const secret = await getSecretByName({
      actorId,
      actor,
      actorOrgId,
      actorAuthMethod,
      projectId: project.id,
      environment,
      path: secretPath,
      secretName,
      type
    });

    if (!secret) {
      throw new BadRequestError({ message: "Secret not found" });
    }
    const folder = await folderDAL.findBySecretPath(project.id, environment, secretPath);

    if (!folder) {
      throw new BadRequestError({ message: "Folder not found" });
    }

    const tags = await secretTagDAL.find({
      projectId: project.id,
      $in: {
        slug: tagSlugs
      }
    });

    if (tags.length !== tagSlugs.length) {
      throw new BadRequestError({ message: "One or more tags not found." });
    }

    const existingSecretTags = await secretDAL.getSecretTags(secret.id);

    if (existingSecretTags.some((tag) => tagSlugs.includes(tag.slug))) {
      throw new BadRequestError({ message: "One or more tags already exist on the secret" });
    }

    const combinedTags = new Set([...existingSecretTags.map((tag) => tag.id), ...tags.map((el) => el.id)]);

    const updatedSecret = await secretDAL.transaction(async (tx) =>
      fnSecretBulkUpdate({
        folderId: folder.id,
        projectId: project.id,
        inputSecrets: [
          {
            filter: { id: secret.id },
            data: {
              tags: Array.from(combinedTags)
            }
          }
        ],
        secretDAL,
        secretVersionDAL,
        secretTagDAL,
        secretVersionTagDAL,
        tx
      })
    );

    await snapshotService.performSnapshot(folder.id);
    await secretQueueService.syncSecrets({ secretPath, projectId: project.id, environment });

    return {
      ...updatedSecret[0],
      tags: [...existingSecretTags, ...tags].map((t) => ({ id: t.id, slug: t.slug, name: t.name, color: t.color }))
    };
  };

  const detachTags = async ({
    secretName,
    tagSlugs,
    path: secretPath,
    environment,
    type,
    projectSlug,
    actor,
    actorAuthMethod,
    actorOrgId,
    actorId
  }: TAttachSecretTagsDTO) => {
    const project = await projectDAL.findProjectBySlug(projectSlug, actorOrgId);

    const { permission } = await permissionService.getProjectPermission(
      actor,
      actorId,
      project.id,
      actorAuthMethod,
      actorOrgId
    );

    ForbiddenError.from(permission).throwUnlessCan(
      ProjectPermissionActions.Edit,
      subject(ProjectPermissionSub.Secrets, { environment, secretPath })
    );

    await projectDAL.checkProjectUpgradeStatus(project.id);

    const secret = await getSecretByName({
      actorId,
      actor,
      actorOrgId,
      actorAuthMethod,
      projectId: project.id,
      environment,
      path: secretPath,
      secretName,
      type
    });

    if (!secret) {
      throw new BadRequestError({ message: "Secret not found" });
    }
    const folder = await folderDAL.findBySecretPath(project.id, environment, secretPath);

    if (!folder) {
      throw new BadRequestError({ message: "Folder not found" });
    }

    const tags = await secretTagDAL.find({
      projectId: project.id,
      $in: {
        slug: tagSlugs
      }
    });

    if (tags.length !== tagSlugs.length) {
      throw new BadRequestError({ message: "One or more tags not found." });
    }

    const existingSecretTags = await secretDAL.getSecretTags(secret.id);

    // Make sure all the tags exist on the secret
    const tagIdsToRemove = tags.map((tag) => tag.id);
    const secretTagIds = existingSecretTags.map((tag) => tag.id);

    if (!tagIdsToRemove.every((el) => secretTagIds.includes(el))) {
      throw new BadRequestError({ message: "One or more tags not found on the secret" });
    }

    const newTags = existingSecretTags.filter((tag) => !tagIdsToRemove.includes(tag.id));

    const updatedSecret = await secretDAL.transaction(async (tx) =>
      fnSecretBulkUpdate({
        folderId: folder.id,
        projectId: project.id,
        inputSecrets: [
          {
            filter: { id: secret.id },
            data: {
              tags: newTags.map((tag) => tag.id)
            }
          }
        ],
        secretDAL,
        secretVersionDAL,
        secretTagDAL,
        secretVersionTagDAL,
        tx
      })
    );

    await snapshotService.performSnapshot(folder.id);
    await secretQueueService.syncSecrets({ secretPath, projectId: project.id, environment });

    return {
      ...updatedSecret[0],
      tags: newTags
    };
  };

  return {
    attachTags,
    detachTags,
    createSecret,
    deleteSecret,
    updateSecret,
    createManySecret,
    updateManySecret,
    deleteManySecret,
    getSecretByName,
    getSecrets,
    getSecretsRaw,
    getSecretByNameRaw,
    createSecretRaw,
    updateSecretRaw,
    deleteSecretRaw,
    createManySecretsRaw,
    updateManySecretsRaw,
    deleteManySecretsRaw,
    getSecretVersions,
    // external services function
    fnSecretBulkDelete,
    fnSecretBulkUpdate,
    fnSecretBlindIndexCheck,
    fnSecretBulkInsert,
    fnSecretBlindIndexCheckV2
  };
};
