#!/usr/bin/env node

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

const REPOSITORY = "Spitfine/aircraft-tycoon-website";
const PREVIEW_ACTION = "preview-development-update";
const DRAFT_MEDIA_PREFIX = "/__draft-media/development-updates/";
const ALLOWED_MEDIA_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const BLOCK_TYPES = new Set(["prose", "image", "comparison", "callout", "stats", "note"]);
const FORBIDDEN_UPDATE_KEYS = [
  "status",
  "publicationDate",
  "slug",
  "canonicalUrl",
  "type",
  "sidebar",
  "steam"
];

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = realpathSync(resolve(dirname(scriptPath), "..", ".."));
const draftRoot = realpathSync(resolve(repositoryRoot, "editorial-drafts", "development-updates"));
const draftMediaRoot = realpathSync(
  resolve(repositoryRoot, "editorial-drafts", "media", "development-updates")
);

class ContractError extends Error {
  constructor(message, errors = [message]) {
    super(message);
    this.name = "ContractError";
    this.errors = errors;
  }
}

function toPosix(value) {
  return value.split(sep).join("/");
}

function isInside(root, candidate) {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function parseFlags(values) {
  const flags = new Map();

  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key.startsWith("--") || key.length === 2) {
      throw new ContractError(`Unexpected argument: ${key}`);
    }
    if (flags.has(key)) {
      throw new ContractError(`Duplicate argument: ${key}`);
    }
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ContractError(`Missing value for ${key}`);
    }
    flags.set(key, value);
    index += 1;
  }

  return flags;
}

function requireOnlyFlags(flags, allowed) {
  for (const key of flags.keys()) {
    if (!allowed.has(key)) {
      throw new ContractError(`Unsupported argument: ${key}`);
    }
  }
}

function hasControlCharacters(value) {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function resolveDraftPath(draftArgument) {
  if (typeof draftArgument !== "string" || draftArgument.trim() === "") {
    throw new ContractError("A draft path is required.");
  }
  if (hasControlCharacters(draftArgument)) {
    throw new ContractError("Draft path contains control characters.");
  }

  const candidate = isAbsolute(draftArgument)
    ? resolve(draftArgument)
    : resolve(repositoryRoot, draftArgument);

  if (!existsSync(candidate)) {
    throw new ContractError(`Draft does not exist: ${draftArgument}`);
  }

  const realCandidate = realpathSync(candidate);
  if (!isInside(draftRoot, realCandidate)) {
    throw new ContractError("Draft must resolve under editorial-drafts/development-updates/.");
  }
  if (extname(realCandidate).toLowerCase() !== ".md") {
    throw new ContractError("Draft must be a Markdown (.md) file.");
  }
  if (!lstatSync(realCandidate).isFile()) {
    throw new ContractError("Draft path must resolve to a file.");
  }

  return {
    absolute: realCandidate,
    repositoryPath: toPosix(relative(repositoryRoot, realCandidate))
  };
}

function parseDraft(draftPath) {
  try {
    const parsed = matter(readFileSync(draftPath.absolute, "utf8"));
    if (!parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
      throw new Error("frontmatter root must be an object");
    }
    return parsed.data;
  } catch (error) {
    throw new ContractError(`Invalid YAML/frontmatter: ${error.message}`);
  }
}

function getValue(root, path) {
  return path
    .replace(/\[(\d+)\]/gu, ".$1")
    .split(".")
    .reduce((value, key) => value?.[key], root);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function requireText(data, path, errors) {
  if (!isNonEmptyString(getValue(data, path))) {
    errors.push(`Missing or empty required field: ${path}`);
  }
}

function slugify(title) {
  if (!isNonEmptyString(title)) {
    return "";
  }

  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[’']/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
}

function validatePublicationDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) {
    return false;
  }

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= monthLengths[month - 1];
}

function resolveMediaReference(reference, fieldPath, errors) {
  if (reference === undefined || reference === null || reference === "") {
    return null;
  }
  if (!isNonEmptyString(reference)) {
    errors.push(`${fieldPath} must be a non-empty draft-media URL when provided.`);
    return null;
  }
  if (hasControlCharacters(reference) || reference.includes("\\")) {
    errors.push(`${fieldPath} contains unsafe characters.`);
    return null;
  }
  if (!reference.startsWith(DRAFT_MEDIA_PREFIX)) {
    errors.push(`${fieldPath} must use ${DRAFT_MEDIA_PREFIX}`);
    return null;
  }
  if (reference.includes("?") || reference.includes("#")) {
    errors.push(`${fieldPath} must not contain a query string or fragment.`);
    return null;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(reference.slice(DRAFT_MEDIA_PREFIX.length));
  } catch {
    errors.push(`${fieldPath} contains invalid URL encoding.`);
    return null;
  }

  if (!decoded || decoded.includes("\\") || hasControlCharacters(decoded)) {
    errors.push(`${fieldPath} contains an unsafe media path.`);
    return null;
  }

  const candidate = resolve(draftMediaRoot, decoded);
  if (!isInside(draftMediaRoot, candidate)) {
    errors.push(`${fieldPath} escapes the draft media directory.`);
    return null;
  }
  if (!ALLOWED_MEDIA_EXTENSIONS.has(extname(candidate).toLowerCase())) {
    errors.push(`${fieldPath} must reference png, jpg, jpeg or webp media.`);
    return null;
  }
  if (!existsSync(candidate)) {
    errors.push(`${fieldPath} references missing draft media.`);
    return null;
  }

  const realCandidate = realpathSync(candidate);
  if (!isInside(draftMediaRoot, realCandidate) || !lstatSync(realCandidate).isFile()) {
    errors.push(`${fieldPath} resolves outside the draft media authority.`);
    return null;
  }

  return {
    fieldPath,
    url: reference,
    absolute: realCandidate,
    sourcePath: toPosix(relative(repositoryRoot, realCandidate)),
    filename: toPosix(relative(draftMediaRoot, realCandidate)).split("/").at(-1)
  };
}

function validateDraftStructure(data, strictPublish) {
  const errors = [];
  const media = [];
  const update = data.update;

  if (Object.prototype.hasOwnProperty.call(data, "layout")) {
    errors.push("Draft must not define publication key: layout");
  }
  if (Object.prototype.hasOwnProperty.call(data, "permalink")) {
    errors.push("Draft must not define publication key: permalink");
  }
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    errors.push("Draft must define update as an object.");
  } else {
    for (const key of FORBIDDEN_UPDATE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(update, key)) {
        errors.push(`Draft must not define publication key: update.${key}`);
      }
    }
  }

  requireText(data, "update.title.en", errors);

  const coverReference = resolveMediaReference(getValue(data, "update.cover.src"), "update.cover.src", errors);
  if (coverReference) {
    media.push(coverReference);
  }

  const sections = data.sections ?? [];
  if (!Array.isArray(sections)) {
    errors.push("sections must be an array when provided.");
  } else {
    sections.forEach((section, sectionIndex) => {
      const prefix = `sections[${sectionIndex}]`;
      if (!section || typeof section !== "object" || Array.isArray(section)) {
        errors.push(`${prefix} must be an object.`);
        return;
      }
      if (!BLOCK_TYPES.has(section.type)) {
        errors.push(`${prefix}.type is unsupported: ${String(section.type)}`);
        return;
      }

      if (section.type === "image") {
        const imageReference = resolveMediaReference(section.image?.src, `${prefix}.image.src`, errors);
        if (imageReference) {
          media.push(imageReference);
        }
      }

      if (section.type === "comparison") {
        if (!Array.isArray(section.images) || section.images.length !== 2) {
          errors.push(`${prefix}.images must contain exactly 2 images.`);
        } else {
          section.images.forEach((image, imageIndex) => {
            const imageReference = resolveMediaReference(
              image?.src,
              `${prefix}.images[${imageIndex}].src`,
              errors
            );
            if (imageReference) {
              media.push(imageReference);
            }
          });
        }
      }
    });
  }

  if (strictPublish) {
    [
      "update.title.pt",
      "update.category",
      "update.description",
      "update.socialDescription",
      "update.deck.en",
      "update.deck.pt",
      "update.surfaces.archive.excerpt.en",
      "update.surfaces.archive.excerpt.pt",
      "update.surfaces.homepage.excerpt.en",
      "update.surfaces.homepage.excerpt.pt",
      "update.cover.src",
      "update.cover.alt"
    ].forEach((path) => requireText(data, path, errors));

    if (!Array.isArray(sections) || sections.length === 0) {
      errors.push("At least one section is required for publication.");
    } else {
      sections.forEach((section, sectionIndex) => {
        if (!section || !BLOCK_TYPES.has(section.type)) {
          return;
        }
        const prefix = `sections[${sectionIndex}]`;

        if (section.type === "prose") {
          requireText(data, `${prefix}.body.en`, errors);
          requireText(data, `${prefix}.body.pt`, errors);
        } else if (section.type === "image") {
          requireText(data, `${prefix}.image.src`, errors);
          requireText(data, `${prefix}.image.alt.en`, errors);
          requireText(data, `${prefix}.image.alt.pt`, errors);
        } else if (section.type === "comparison" && Array.isArray(section.images)) {
          section.images.forEach((image, imageIndex) => {
            requireText(data, `${prefix}.images[${imageIndex}].src`, errors);
            requireText(data, `${prefix}.images[${imageIndex}].alt.en`, errors);
            requireText(data, `${prefix}.images[${imageIndex}].alt.pt`, errors);
          });
        } else if (section.type === "callout") {
          requireText(data, `${prefix}.title.en`, errors);
          requireText(data, `${prefix}.title.pt`, errors);
          requireText(data, `${prefix}.body.en`, errors);
          requireText(data, `${prefix}.body.pt`, errors);
        } else if (section.type === "stats") {
          if (!Array.isArray(section.items) || section.items.length === 0) {
            errors.push(`${prefix}.items must contain at least one item.`);
          } else {
            section.items.forEach((item, itemIndex) => {
              requireText(data, `${prefix}.items[${itemIndex}].value.en`, errors);
              requireText(data, `${prefix}.items[${itemIndex}].value.pt`, errors);
              requireText(data, `${prefix}.items[${itemIndex}].label.en`, errors);
              requireText(data, `${prefix}.items[${itemIndex}].label.pt`, errors);
            });
          }
        } else if (section.type === "note") {
          requireText(data, `${prefix}.body.en`, errors);
          requireText(data, `${prefix}.body.pt`, errors);
        }
      });
    }
  }

  const uniqueMedia = [];
  const seenSources = new Map();
  const filenames = new Map();
  for (const item of media) {
    if (seenSources.has(item.absolute)) {
      const existingItem = seenSources.get(item.absolute);
      if (!existingItem.urls.includes(item.url)) {
        existingItem.urls.push(item.url);
      }
      continue;
    }
    if (filenames.has(item.filename) && filenames.get(item.filename) !== item.absolute) {
      errors.push(`Draft media filename collision: ${item.filename}`);
      continue;
    }
    filenames.set(item.filename, item.absolute);
    item.urls = [item.url];
    seenSources.set(item.absolute, item);
    uniqueMedia.push(item);
  }

  return { errors, media: uniqueMedia };
}

function validatePagesCmsPayload(environmentName) {
  const rawPayload = process.env[environmentName];
  if (!rawPayload) {
    throw new ContractError(`Environment variable ${environmentName} is empty.`);
  }

  let payload;
  try {
    payload = JSON.parse(rawPayload);
  } catch (error) {
    throw new ContractError(`Malformed Pages CMS payload JSON: ${error.message}`);
  }

  const errors = [];
  if (payload?.source !== "pages-cms") errors.push('payload.source must equal "pages-cms".');
  if (payload?.action?.name !== PREVIEW_ACTION) {
    errors.push(`payload.action.name must equal "${PREVIEW_ACTION}".`);
  }
  if (payload?.context?.type !== "entry") errors.push('payload.context.type must equal "entry".');
  if (payload?.context?.name !== "development_update_drafts") {
    errors.push('payload.context.name must equal "development_update_drafts".');
  }
  const payloadRepositoryOwner = payload?.repository?.owner;
  const payloadRepositoryName = payload?.repository?.repo;
  const payloadRepository =
    typeof payloadRepositoryOwner === "string" && typeof payloadRepositoryName === "string"
      ? `${payloadRepositoryOwner}/${payloadRepositoryName}`.toLowerCase()
      : null;
  if (payloadRepository !== REPOSITORY.toLowerCase()) {
    errors.push(`payload repository must equal ${REPOSITORY}.`);
  }
  if (
    process.env.GITHUB_REPOSITORY &&
    process.env.GITHUB_REPOSITORY.toLowerCase() !== REPOSITORY.toLowerCase()
  ) {
    errors.push(`GITHUB_REPOSITORY must equal ${REPOSITORY}.`);
  }

  const payloadRef = payload?.repository?.ref?.replace(/^refs\/heads\//u, "");
  const dispatchRef = process.env.GITHUB_REF_NAME?.replace(/^refs\/heads\//u, "");
  if (!isNonEmptyString(payloadRef)) {
    errors.push("payload.repository.ref is required.");
  } else if (dispatchRef && payloadRef !== dispatchRef) {
    errors.push("payload.repository.ref does not match the dispatched ref.");
  }

  const payloadSha = payload?.repository?.sha;
  if (typeof payloadSha !== "string" || !/^[0-9a-f]{40}$/iu.test(payloadSha)) {
    errors.push("payload.repository.sha must be a full Git SHA.");
  } else if (process.env.GITHUB_SHA && payloadSha.toLowerCase() !== process.env.GITHUB_SHA.toLowerCase()) {
    errors.push("payload.repository.sha does not match the checked-out dispatch SHA.");
  }

  if (errors.length > 0) {
    throw new ContractError("Pages CMS payload validation failed.", errors);
  }

  return {
    draft: payload.context.path,
    ref: payloadRef,
    sha: payloadSha.toLowerCase()
  };
}

function createPublicationPlan(draftPath, data, media, publicationDate, validationErrors) {
  const slug = slugify(getValue(data, "update.title.en"));
  if (!slug) {
    validationErrors.push("update.title.en must produce a non-empty URL-safe slug.");
  }
  const dateValid = validatePublicationDate(publicationDate);
  if (!dateValid) {
    validationErrors.push("Publication date must be a real date in YYYY-MM-DD format.");
  }

  const targetMarkdownPath = slug && dateValid
    ? `content/development-updates/${publicationDate}-${slug}.md`
    : null;
  const publicPermalink = slug && dateValid
    ? `/updates/${publicationDate}-${slug}.html`
    : null;
  const targetPublicMediaDirectory = slug ? `assets/updates/${slug}/` : null;
  const mediaMappings = media.map((item) => ({
    source: item.sourcePath,
    destination: slug ? `assets/updates/${slug}/${item.filename}` : null,
    publicUrl: slug ? `/assets/updates/${slug}/${item.filename}` : null
  }));

  return {
    command: "validate-publish",
    draftSourcePath: draftPath.repositoryPath,
    publicationDate,
    derivedSlug: slug || null,
    targetMarkdownPath,
    publicPermalink,
    targetPublicMediaDirectory,
    draftMediaSourcePaths: media.map((item) => item.sourcePath),
    mediaMappings,
    validationStatus: validationErrors.length === 0 ? "PASS" : "FAIL",
    errors: validationErrors
  };
}

function rewritePreviewMedia(data, media, slug) {
  const previewData = structuredClone(data);
  const replacements = new Map(
    media.flatMap((item) =>
      item.urls.map((url) => [url, `/assets/__editorial-preview/${slug}/${item.filename}`])
    )
  );

  if (previewData.update?.cover?.src && replacements.has(previewData.update.cover.src)) {
    previewData.update.cover.src = replacements.get(previewData.update.cover.src);
  }
  if (Array.isArray(previewData.sections)) {
    for (const section of previewData.sections) {
      if (section.type === "image" && replacements.has(section.image?.src)) {
        section.image.src = replacements.get(section.image.src);
      }
      if (section.type === "comparison" && Array.isArray(section.images)) {
        for (const image of section.images) {
          if (replacements.has(image?.src)) {
            image.src = replacements.get(image.src);
          }
        }
      }
    }
  }

  return previewData;
}

function buildPreviewDocument(data, media, slug) {
  const rewritten = rewritePreviewMedia(data, media, slug);
  const draftUpdate = rewritten.update ?? {};
  const cover = draftUpdate.cover ?? {};
  const permalink = `/__editorial-preview/${slug}.html`;

  return {
    layout: "layouts/development-update.njk",
    permalink,
    update: {
      title: draftUpdate.title ?? {},
      category: draftUpdate.category ?? "",
      description: draftUpdate.description ?? "",
      socialDescription: draftUpdate.socialDescription ?? "",
      deck: draftUpdate.deck ?? {},
      surfaces: draftUpdate.surfaces ?? {},
      cover: {
        ...cover,
        absoluteUrl: cover.src ? `https://editorial-preview.invalid${cover.src}` : ""
      },
      status: "preview",
      publicationDate: "",
      slug,
      displayDate: {
        en: "Editorial preview",
        pt: "Pré-visualização editorial"
      },
      type: {
        en: "Development Update Preview",
        pt: "Pré-visualização de Atualização de Desenvolvimento"
      },
      canonicalUrl: `https://editorial-preview.invalid${permalink}`,
      sidebar: {
        title: {
          en: "Editorial preview",
          pt: "Pré-visualização editorial"
        },
        copy: {
          en: "This is an unpublished editorial preview and may be incomplete.",
          pt: "Esta é uma pré-visualização editorial não publicada e pode estar incompleta."
        }
      },
      steam: {
        kicker: { en: "", pt: "" },
        title: { en: "", pt: "" },
        copy: { en: "", pt: "" },
        widget: { en: "", pt: "" }
      }
    },
    sections: rewritten.sections ?? []
  };
}

function countHtmlFiles(directory) {
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      count += countHtmlFiles(entryPath);
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      count += 1;
    }
  }
  return count;
}

function removeEmptyDirectory(directory) {
  if (existsSync(directory) && readdirSync(directory).length === 0) {
    rmdirSync(directory);
  }
}

function appendWorkflowOutputs(result) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }
  const outputValues = [result.draftSourcePath, result.previewPath, result.derivedSlug, result.sourceSha ?? ""];
  if (outputValues.some((value) => hasControlCharacters(value))) {
    throw new ContractError("Workflow output contains unsafe control characters.");
  }
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `draft_path=${result.draftSourcePath}\npreview_path=${result.previewPath}\nslug=${result.derivedSlug}\nsource_sha=${result.sourceSha ?? ""}\n`,
    "utf8"
  );
}

function runPreview(draftPath, data, media, sourceSha) {
  const slug = slugify(getValue(data, "update.title.en"));
  if (!slug) {
    throw new ContractError("update.title.en must produce a non-empty URL-safe slug.");
  }

  const temporaryMarkdown = resolve(
    repositoryRoot,
    "content",
    "development-updates",
    `__editorial-preview-${slug}.md`
  );
  const temporaryMediaParent = resolve(repositoryRoot, "assets", "__editorial-preview");
  const temporaryMediaDirectory = resolve(temporaryMediaParent, slug);
  const previewPath = `/__editorial-preview/${slug}.html`;
  const previewOutput = resolve(repositoryRoot, "_site", "__editorial-preview", `${slug}.html`);
  const stalePreviewRoots = [
    resolve(repositoryRoot, "_site", "__editorial-preview"),
    resolve(repositoryRoot, "_site", "assets", "__editorial-preview")
  ];

  if (existsSync(temporaryMarkdown) || existsSync(temporaryMediaDirectory)) {
    throw new ContractError("Temporary preview staging path already exists; refusing to overwrite it.");
  }

  let markdownCreated = false;
  let mediaDirectoryCreated = false;
  let previewSucceeded = false;
  try {
    for (const stalePreviewRoot of stalePreviewRoots) {
      if (existsSync(stalePreviewRoot)) {
        rmSync(stalePreviewRoot, { recursive: true, force: false });
      }
    }

    const previewDocument = buildPreviewDocument(data, media, slug);
    writeFileSync(temporaryMarkdown, matter.stringify("", previewDocument), "utf8");
    markdownCreated = true;

    if (media.length > 0) {
      mkdirSync(temporaryMediaDirectory, { recursive: true });
      mediaDirectoryCreated = true;
      for (const item of media) {
        copyFileSync(item.absolute, resolve(temporaryMediaDirectory, item.filename));
      }
    }

    const windows = process.platform === "win32";
    const npmCommand = windows ? (process.env.ComSpec || "cmd.exe") : "npm";
    const npmArguments = windows ? ["/d", "/s", "/c", "npm run build"] : ["run", "build"];
    const build = spawnSync(npmCommand, npmArguments, {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    if (build.stdout) process.stdout.write(build.stdout);
    if (build.stderr) process.stderr.write(build.stderr);
    if (build.error) {
      throw new ContractError(`Preview build could not start: ${build.error.message}`);
    }
    if (build.status !== 0) {
      throw new ContractError(`Preview build failed with exit code ${build.status}.`);
    }
    if (!existsSync(previewOutput)) {
      throw new ContractError(`Preview output was not created: ${previewPath}`);
    }

    const htmlPageCount = countHtmlFiles(resolve(repositoryRoot, "_site"));
    if (htmlPageCount !== 4) {
      throw new ContractError(`Preview build must contain exactly 4 HTML pages; found ${htmlPageCount}.`);
    }

    const result = {
      command: "preview",
      draftSourcePath: draftPath.repositoryPath,
      sourceSha: sourceSha || null,
      derivedSlug: slug,
      previewPath,
      previewOutput: toPosix(relative(repositoryRoot, previewOutput)),
      stagedMedia: media.map((item) => ({
        source: item.sourcePath,
        previewUrl: `/assets/__editorial-preview/${slug}/${item.filename}`
      })),
      htmlPageCount,
      validationStatus: "PASS",
      errors: []
    };
    appendWorkflowOutputs(result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    previewSucceeded = true;
  } finally {
    if (markdownCreated && existsSync(temporaryMarkdown)) {
      unlinkSync(temporaryMarkdown);
    }
    if (mediaDirectoryCreated && existsSync(temporaryMediaDirectory)) {
      rmSync(temporaryMediaDirectory, { recursive: true, force: false });
    }
    removeEmptyDirectory(temporaryMediaParent);
    if (!previewSucceeded) {
      for (const stalePreviewRoot of stalePreviewRoots) {
        if (existsSync(stalePreviewRoot)) {
          rmSync(stalePreviewRoot, { recursive: true, force: false });
        }
      }
    }
  }
}

function execute() {
  const command = process.argv[2];
  const flags = parseFlags(process.argv.slice(3));

  if (command === "preview") {
    requireOnlyFlags(flags, new Set(["--draft", "--payload-env"]));
    const hasDraft = flags.has("--draft");
    const hasPayload = flags.has("--payload-env");
    if (hasDraft === hasPayload) {
      throw new ContractError("preview requires exactly one of --draft or --payload-env.");
    }

    const payload = hasPayload ? validatePagesCmsPayload(flags.get("--payload-env")) : null;
    const draftPath = resolveDraftPath(payload?.draft ?? flags.get("--draft"));
    const data = parseDraft(draftPath);
    const validation = validateDraftStructure(data, false);
    if (validation.errors.length > 0) {
      throw new ContractError("Preview validation failed.", validation.errors);
    }
    runPreview(draftPath, data, validation.media, payload?.sha);
    return;
  }

  if (command === "validate-publish") {
    requireOnlyFlags(flags, new Set(["--draft", "--publication-date"]));
    const draftPath = resolveDraftPath(flags.get("--draft"));
    const data = parseDraft(draftPath);
    const validation = validateDraftStructure(data, true);
    const plan = createPublicationPlan(
      draftPath,
      data,
      validation.media,
      flags.get("--publication-date"),
      validation.errors
    );
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    if (plan.validationStatus !== "PASS") {
      process.exitCode = 1;
    }
    return;
  }

  throw new ContractError("Command must be preview or validate-publish.");
}

try {
  execute();
} catch (error) {
  const errors = error instanceof ContractError ? error.errors : [error.message];
  process.stderr.write(`${JSON.stringify({ validationStatus: "FAIL", errors }, null, 2)}\n`);
  process.exitCode = 1;
}
