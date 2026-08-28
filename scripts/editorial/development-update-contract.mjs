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
const PREPARE_PUBLICATION_ACTION = "prepare-development-update-publication";
const DRAFT_MEDIA_PREFIX = "/__draft-media/development-updates/";
const ALLOWED_MEDIA_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const BLOCK_TYPES = new Set(["prose", "image", "comparison", "callout", "stats", "note"]);
const ENGLISH_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];
const PORTUGUESE_MONTHS = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro"
];
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

function parsePagesCmsPayload(environmentName) {
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

  return payload;
}

function validatePagesCmsPayload(environmentName, mode = "preview") {
  const payload = parsePagesCmsPayload(environmentName);
  const promotion = mode === "prepare-publish";
  const expectedAction = promotion ? PREPARE_PUBLICATION_ACTION : PREVIEW_ACTION;

  const errors = [];
  if (payload?.source !== "pages-cms") errors.push('payload.source must equal "pages-cms".');
  if (payload?.action?.name !== expectedAction) {
    errors.push(`payload.action.name must equal "${expectedAction}".`);
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
  } else if (promotion && payloadRef !== "main") {
    errors.push('payload.repository.ref must equal "main" for publication preparation.');
  } else if (!promotion && dispatchRef && payloadRef !== dispatchRef) {
    errors.push("payload.repository.ref does not match the dispatched ref.");
  }
  if (promotion && dispatchRef !== "main") {
    errors.push('GITHUB_REF_NAME must equal "main" for publication preparation.');
  }

  const payloadSha = payload?.repository?.sha;
  if (typeof payloadSha !== "string" || !/^[0-9a-f]{40}$/iu.test(payloadSha)) {
    errors.push("payload.repository.sha must be a full Git SHA.");
  } else if (
    promotion &&
    (typeof process.env.GITHUB_SHA !== "string" ||
      !/^[0-9a-f]{40}$/iu.test(process.env.GITHUB_SHA) ||
      payloadSha.toLowerCase() !== process.env.GITHUB_SHA.toLowerCase())
  ) {
    errors.push("payload.repository.sha does not match the checked-out dispatch SHA.");
  } else if (
    !promotion &&
    process.env.GITHUB_SHA &&
    payloadSha.toLowerCase() !== process.env.GITHUB_SHA.toLowerCase()
  ) {
    errors.push("payload.repository.sha does not match the checked-out dispatch SHA.");
  }

  const entryBlobSha = payload?.context?.data?.sha;
  if (
    promotion &&
    entryBlobSha !== undefined &&
    (typeof entryBlobSha !== "string" || !/^[0-9a-f]{40}$/iu.test(entryBlobSha))
  ) {
    errors.push("payload.context.data.sha must be a full Git blob SHA when supplied.");
  }

  const publicationDate = payload?.inputs?.["publication-date"];
  if (promotion && !validatePublicationDate(publicationDate)) {
    errors.push("payload.inputs.publication-date must be a real date in YYYY-MM-DD format.");
  }
  if (promotion && payload?.inputs?.["reviewed-preview"] !== true) {
    errors.push("payload.inputs.reviewed-preview must equal true.");
  }
  if (promotion && payload?.inputs?.["claims-verified"] !== true) {
    errors.push("payload.inputs.claims-verified must equal true.");
  }

  if (errors.length > 0) {
    throw new ContractError("Pages CMS payload validation failed.", errors);
  }

  return {
    draft: payload.context.path,
    ref: payloadRef,
    sha: payloadSha.toLowerCase(),
    entryBlobSha: typeof entryBlobSha === "string" ? entryBlobSha.toLowerCase() : null,
    publicationDate: promotion ? publicationDate : null
  };
}

function validateEntryBlobFreshness(draftPath, expectedBlobSha) {
  if (!expectedBlobSha) {
    return;
  }

  const lookup = spawnSync("git", ["ls-tree", "HEAD", "--", draftPath.repositoryPath], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  if (lookup.error) {
    throw new ContractError(`Could not inspect the checked-out draft Git blob: ${lookup.error.message}`);
  }
  if (lookup.status !== 0) {
    throw new ContractError(
      `Could not inspect the checked-out draft Git blob: ${lookup.stderr.trim() || "git ls-tree failed"}`
    );
  }

  const blobMatch = lookup.stdout.match(/^\d+\s+blob\s+([0-9a-f]{40})\t/u);
  if (!blobMatch) {
    throw new ContractError("The checked-out draft does not resolve to a tracked Git blob at HEAD.");
  }
  if (blobMatch[1].toLowerCase() !== expectedBlobSha.toLowerCase()) {
    throw new ContractError("payload.context.data.sha does not match the checked-out draft Git blob SHA.");
  }
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
  const canonicalUrl = publicPermalink
    ? `https://aircraft-tycoon.com${publicPermalink}`
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
    englishTitle: getValue(data, "update.title.en"),
    publicationDate,
    derivedSlug: slug || null,
    targetMarkdownPath,
    publicPermalink,
    canonicalUrl,
    targetPublicMediaDirectory,
    draftMediaSourcePaths: media.map((item) => item.sourcePath),
    mediaMappings,
    validationStatus: validationErrors.length === 0 ? "PASS" : "FAIL",
    errors: validationErrors
  };
}

function resolvePublicationInvocation(flags, commandName) {
  requireOnlyFlags(flags, new Set(["--draft", "--publication-date", "--payload-env"]));
  const hasDraft = flags.has("--draft");
  const hasPublicationDate = flags.has("--publication-date");
  const hasPayload = flags.has("--payload-env");

  if (hasPayload) {
    if (hasDraft || hasPublicationDate) {
      throw new ContractError(
        `${commandName} workflow mode cannot be combined with --draft or --publication-date.`
      );
    }
    const payload = validatePagesCmsPayload(flags.get("--payload-env"), "prepare-publish");
    const draftPath = resolveDraftPath(payload.draft);
    validateEntryBlobFreshness(draftPath, payload.entryBlobSha);
    return {
      draftPath,
      publicationDate: payload.publicationDate,
      sourceSha: payload.sha
    };
  }

  if (!hasDraft || !hasPublicationDate) {
    throw new ContractError(
      `${commandName} local mode requires both --draft and --publication-date.`
    );
  }
  return {
    draftPath: resolveDraftPath(flags.get("--draft")),
    publicationDate: flags.get("--publication-date"),
    sourceSha: null
  };
}

function createValidatedPublicationContext(flags, commandName) {
  const invocation = resolvePublicationInvocation(flags, commandName);
  const data = parseDraft(invocation.draftPath);
  const validation = validateDraftStructure(data, true);
  const plan = createPublicationPlan(
    invocation.draftPath,
    data,
    validation.media,
    invocation.publicationDate,
    validation.errors
  );
  return { ...invocation, data, media: validation.media, plan };
}

function formatDisplayDate(publicationDate) {
  const [year, month, day] = publicationDate.split("-").map(Number);
  return {
    en: `${day} ${ENGLISH_MONTHS[month - 1]} ${year}`,
    pt: `${day} de ${PORTUGUESE_MONTHS[month - 1]} de ${year}`
  };
}

function buildSteamWidgetUrl(language, slug, content) {
  const parameters = new URLSearchParams([
    ["l", language],
    ["utm_source", "official_website"],
    ["utm_medium", "development_update"],
    ["utm_campaign", `development_update_${slug}`],
    ["utm_content", content]
  ]);
  return `https://store.steampowered.com/widget/4997100/?${parameters.toString()}`;
}

function rewritePublicationMedia(data, media, mediaMappings) {
  const publicationData = structuredClone(data);
  const replacements = new Map(
    media.flatMap((item, index) => item.urls.map((url) => [url, mediaMappings[index].publicUrl]))
  );

  if (publicationData.update?.cover?.src && replacements.has(publicationData.update.cover.src)) {
    publicationData.update.cover.src = replacements.get(publicationData.update.cover.src);
  }
  if (Array.isArray(publicationData.sections)) {
    for (const section of publicationData.sections) {
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

  return publicationData;
}

function buildPublicationDocument(data, media, plan) {
  const rewritten = rewritePublicationMedia(data, media, plan.mediaMappings);
  const draftUpdate = rewritten.update;
  const coverSrc = draftUpdate.cover.src;

  return {
    layout: "layouts/development-update.njk",
    permalink: plan.publicPermalink,
    update: {
      status: "published",
      publicationDate: plan.publicationDate,
      slug: plan.derivedSlug,
      displayDate: formatDisplayDate(plan.publicationDate),
      title: draftUpdate.title,
      type: {
        en: "Development Update",
        pt: "Atualização de Desenvolvimento"
      },
      category: draftUpdate.category,
      description: draftUpdate.description,
      socialDescription: draftUpdate.socialDescription,
      canonicalUrl: plan.canonicalUrl,
      deck: draftUpdate.deck,
      cover: {
        src: coverSrc,
        alt: draftUpdate.cover.alt,
        absoluteUrl: `https://aircraft-tycoon.com${coverSrc}`
      },
      surfaces: draftUpdate.surfaces,
      sidebar: {
        title: {
          en: "Development Update",
          pt: "Atualização de Desenvolvimento"
        },
        copy: {
          en: "Aircraft Tycoon is a historical aviation management game in active development by a solo developer.",
          pt: "Aircraft Tycoon é um jogo histórico de gestão aeronáutica em desenvolvimento ativo por um solo developer."
        }
      },
      steam: {
        kicker: {
          en: "Official Steam page",
          pt: "Página oficial na Steam"
        },
        title: {
          en: "Wishlist Aircraft Tycoon on Steam.",
          pt: "Adiciona Aircraft Tycoon à tua lista de desejos."
        },
        copy: {
          en: "Follow development and add the game to your wishlist for future updates.",
          pt: "Acompanha o desenvolvimento e adiciona o jogo à tua lista de desejos para receber futuras novidades."
        },
        widget: {
          en: buildSteamWidgetUrl("english", plan.derivedSlug, "article_widget_en"),
          pt: buildSteamWidgetUrl("portuguese", plan.derivedSlug, "article_widget_pt")
        }
      }
    },
    sections: rewritten.sections
  };
}

function isSafePublicationFilename(filename) {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(filename) &&
    filename !== "." &&
    filename !== ".." &&
    !filename.endsWith(".")
  );
}

function assertPublicationTargetsAvailable(plan, media) {
  const targetMarkdown = resolve(repositoryRoot, plan.targetMarkdownPath);
  const targetMediaDirectory = resolve(repositoryRoot, plan.targetPublicMediaDirectory);
  if (existsSync(targetMarkdown)) {
    throw new ContractError(`Publication target already exists: ${plan.targetMarkdownPath}`);
  }
  if (existsSync(targetMediaDirectory)) {
    throw new ContractError(`Publication media directory already exists: ${plan.targetPublicMediaDirectory}`);
  }
  for (const item of media) {
    if (!isSafePublicationFilename(item.filename)) {
      throw new ContractError(`Draft media filename is not safe for publication: ${item.filename}`);
    }
  }

  const contentDirectory = resolve(repositoryRoot, "content", "development-updates");
  for (const entry of readdirSync(contentDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || ![".md", ".njk"].includes(extname(entry.name).toLowerCase())) {
      continue;
    }
    const sourcePath = resolve(contentDirectory, entry.name);
    let sourceData;
    try {
      sourceData = matter(readFileSync(sourcePath, "utf8")).data;
    } catch (error) {
      throw new ContractError(`Could not safely inspect existing publication source ${entry.name}: ${error.message}`);
    }
    if (sourceData?.permalink === plan.publicPermalink) {
      throw new ContractError(
        `Publication permalink already belongs to content/development-updates/${entry.name}.`
      );
    }
  }
}

function auditSharedDraftMedia(draftPath, media) {
  const referenceCounts = new Map(media.map((item) => [item.absolute, 0]));
  for (const entry of readdirSync(draftRoot, { withFileTypes: true })) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md") {
      continue;
    }

    const absolute = realpathSync(resolve(draftRoot, entry.name));
    if (absolute === draftPath.absolute) {
      continue;
    }
    const otherDraftPath = {
      absolute,
      repositoryPath: toPosix(relative(repositoryRoot, absolute))
    };
    const otherData = parseDraft(otherDraftPath);
    const otherValidation = validateDraftStructure(otherData, false);
    if (otherValidation.errors.length > 0) {
      throw new ContractError(
        `Cannot safely audit draft media references in ${otherDraftPath.repositoryPath}.`,
        otherValidation.errors.map((error) => `${otherDraftPath.repositoryPath}: ${error}`)
      );
    }

    for (const item of media) {
      if (otherValidation.media.some((candidate) => candidate.absolute === item.absolute)) {
        referenceCounts.set(item.absolute, referenceCounts.get(item.absolute) + 1);
      }
    }
  }
  return referenceCounts;
}

function materializePublication(draftPath, data, media, plan) {
  assertPublicationTargetsAvailable(plan, media);
  const sharedReferenceCounts = auditSharedDraftMedia(draftPath, media);
  const mediaMappings = plan.mediaMappings.map((mapping, index) => {
    const sharedReferenceCount = sharedReferenceCounts.get(media[index].absolute);
    return {
      ...mapping,
      copiedToPublic: true,
      draftSourceRemoved: sharedReferenceCount === 0,
      sharedReferenceCount
    };
  });
  const publicationPlan = { ...plan, mediaMappings };
  const publicationDocument = buildPublicationDocument(data, media, publicationPlan);
  const targetMarkdown = resolve(repositoryRoot, plan.targetMarkdownPath);
  const targetMediaDirectory = resolve(repositoryRoot, plan.targetPublicMediaDirectory);
  const removedSources = [];
  let mediaDirectoryCreated = false;
  let markdownCreated = false;

  try {
    if (media.length > 0) {
      mkdirSync(targetMediaDirectory, { recursive: false });
      mediaDirectoryCreated = true;
      for (let index = 0; index < media.length; index += 1) {
        const destination = resolve(repositoryRoot, mediaMappings[index].destination);
        copyFileSync(media[index].absolute, destination);
        if (!readFileSync(media[index].absolute).equals(readFileSync(destination))) {
          throw new ContractError(`Public media copy differs from its source: ${mediaMappings[index].destination}`);
        }
      }
    }

    writeFileSync(targetMarkdown, matter.stringify("", publicationDocument), "utf8");
    markdownCreated = true;

    for (let index = 0; index < media.length; index += 1) {
      if (mediaMappings[index].draftSourceRemoved) {
        removedSources.push({ absolute: media[index].absolute, contents: readFileSync(media[index].absolute) });
        unlinkSync(media[index].absolute);
      }
    }
    removedSources.push({ absolute: draftPath.absolute, contents: readFileSync(draftPath.absolute) });
    unlinkSync(draftPath.absolute);
  } catch (error) {
    for (const source of removedSources.reverse()) {
      mkdirSync(dirname(source.absolute), { recursive: true });
      writeFileSync(source.absolute, source.contents);
    }
    if (markdownCreated && existsSync(targetMarkdown)) {
      unlinkSync(targetMarkdown);
    }
    if (mediaDirectoryCreated && existsSync(targetMediaDirectory)) {
      rmSync(targetMediaDirectory, { recursive: true, force: false });
    }
    throw error;
  }

  const changedPaths = [
    plan.targetMarkdownPath,
    ...mediaMappings.map((mapping) => mapping.destination),
    draftPath.repositoryPath,
    ...mediaMappings
      .filter((mapping) => mapping.draftSourceRemoved)
      .map((mapping) => mapping.source)
  ].sort();

  return {
    command: "prepare-publish",
    draftSourcePath: draftPath.repositoryPath,
    publicationDate: plan.publicationDate,
    derivedSlug: plan.derivedSlug,
    targetMarkdownPath: plan.targetMarkdownPath,
    publicPermalink: plan.publicPermalink,
    canonicalUrl: plan.canonicalUrl,
    targetPublicMediaDirectory: plan.targetPublicMediaDirectory,
    mediaMappings,
    removedDraftPath: draftPath.repositoryPath,
    changedPaths,
    validationStatus: "PASS",
    errors: []
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

    const payload = hasPayload
      ? validatePagesCmsPayload(flags.get("--payload-env"), "preview")
      : null;
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
    const { plan } = createValidatedPublicationContext(flags, command);
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    if (plan.validationStatus !== "PASS") {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "prepare-publish") {
    const { draftPath, data, media, plan } = createValidatedPublicationContext(flags, command);
    if (plan.validationStatus !== "PASS") {
      throw new ContractError("Publication preparation validation failed.", plan.errors);
    }
    const result = materializePublication(draftPath, data, media, plan);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  throw new ContractError("Command must be preview, validate-publish or prepare-publish.");
}

try {
  execute();
} catch (error) {
  const errors = error instanceof ContractError ? error.errors : [error.message];
  process.stderr.write(`${JSON.stringify({ validationStatus: "FAIL", errors }, null, 2)}\n`);
  process.exitCode = 1;
}
