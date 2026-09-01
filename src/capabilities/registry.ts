import type { AuthPlatform } from "../auth/types.js";
import {
  CHANNEL_CAPABILITY_SCHEMA_VERSION,
  capabilityFact as fact,
  type ChannelStaticCapabilities,
} from "./types.js";
import {
  LINKEDIN_POST_MAX_UTF16_CODE_UNITS,
  WECHAT_BODY_IMAGE_EXTENSIONS,
  WECHAT_COVER_EXTENSIONS,
  X_ARTICLE_COVER_POSITIVE_EXTENSIONS,
  X_PREMIUM_POST_PLATFORM_MAX_LENGTH,
  X_STANDARD_POST_MAX_WEIGHTED_LENGTH,
} from "./validation.js";
import {
  GENERIC_CAPABILITY_WORKFLOW_REF,
  ONEPOINT3ACRES_ENTRY_URL,
  ONEPOINT3ACRES_CAPABILITY_WORKFLOW_REF,
  XHS_ENTRY_URL,
  XHS_CAPABILITY_WORKFLOW_REF,
} from "./workflows.js";

const ISSUE_35 = "https://github.com/fyang0507/publish-cli/issues/35";
const ISSUE_36 = "https://github.com/fyang0507/publish-cli/issues/36";
const ISSUE_37 = "https://github.com/fyang0507/publish-cli/issues/37";
const ISSUE_40 = "https://github.com/fyang0507/publish-cli/issues/40";
const ISSUE_41 = "https://github.com/fyang0507/publish-cli/issues/41";
const ISSUE_42 = "https://github.com/fyang0507/publish-cli/issues/42";
const ISSUE_43 = "https://github.com/fyang0507/publish-cli/issues/43";

const X_COUNTING_DOC = "https://docs.x.com/fundamentals/counting-characters";
const X_LONG_POST_DOC = "https://help.x.com/en/using-x/types-of-posts";
const X_ARTICLE_DOC = "https://help.x.com/en/using-x/articles";
const LINKEDIN_POST_DOC = "https://www.linkedin.com/help/linkedin/answer/a524422?lang=en";
const LINKEDIN_MEDIA_DOC = "https://www.linkedin.com/help/linkedin/answer/a525307/share-photos-or-videos?lang=en";
const LINKEDIN_TYPES_DOC = "https://www.linkedin.com/help/linkedin/answer/a564109?lang=en";
const LINKEDIN_DRAFT_DOC = "https://www.linkedin.com/help/linkedin/answer/a767101/save-a-post-as-a-draft?lang=en";
const WECHAT_COVER_DOC = "https://developers.weixin.qq.com/doc/service/api/material/permanent/api_addmaterial.html";
const WECHAT_BODY_IMAGE_DOC = "https://developers.weixin.qq.com/doc/service/api/material/permanent/api_uploadimage.html";
const WECHAT_DRAFT_DOC = "https://developers.weixin.qq.com/doc/service/api/draftbox/draftmanage/api_draft_add.html";
const WECHAT_QUOTA_DOC = "https://developers.weixin.qq.com/doc/service/api/material/permanent/api_getmaterialcount.html";
const ONEPOINT3ACRES_TERMS = "https://www.1point3acres.com/terms_of_service.html";

const unknown = (source: string, lastVerified: string) =>
  fact(null, "unknown", source, lastVerified);

const registry: Record<AuthPlatform, ChannelStaticCapabilities> = {
  x: {
    schemaVersion: CHANNEL_CAPABILITY_SCHEMA_VERSION,
    channel: "x",
    displayName: "X",
    executionMode: "cli_transport",
    supportBoundary: "Stages native Unsent post/thread drafts and autosaved Article drafts; never posts or publishes.",
    responsibility: {
      cli: [
        "Passively report authentication readiness, validate the selected transport contract, render supplied content, and stage the selected native draft.",
        "For Articles, discover an adjacent prepared cover and operate X's crop/apply flow when a cover is supplied.",
      ],
      agent: [
        "Choose tweet, thread, or Article; prepare the canonical text/Markdown and any already-sized cover; resolve readiness; run the command; inspect the receipt.",
      ],
      human: [
        "Complete login, checkpoint, or Premium purchase when required; review the native draft; make the final Post/Publish decision outside the CLI.",
      ],
      platform: [
        "Decide account eligibility, enforce unknown server limits, transform/crop uploaded media, and persist the native draft.",
      ],
      rationale: [
        "X has separate composer surfaces for posts, threads, and Articles, so each format has a different transport and media contract.",
        "The CLI stops at drafts to preserve a human-gated public-send boundary and does not generate or redesign assets.",
      ],
    },
    excludedCapabilities: [
      {
        id: "public_send",
        disposition: "intentionally_excluded",
        reason: "Public posting and publication are the human approval boundary.",
        owner: "human",
        alternative: "Review the native Unsent/Article draft and use X's final Post or Publish control manually.",
      },
      {
        id: "tweet_thread_media",
        disposition: "deferred",
        reason: "The current tweet/thread transport has no media attachment path.",
        owner: "human",
        alternative: "Attach media during human review, or choose the Article workflow when long-form rich content is required.",
      },
      {
        id: "asset_generation",
        disposition: "intentionally_excluded",
        reason: "The CLI transports supplied assets; it does not crop, resize, compress, convert, or generate them before upload.",
        owner: "agent",
        alternative: "Prepare a 5:2 Article cover before invoking the CLI.",
      },
    ],
    auth: {
      mode: "passive persistent-profile browser probe",
      entryUrl: "https://x.com/home",
      workflowRef: GENERIC_CAPABILITY_WORKFLOW_REF,
      continueInSameContext: true,
    },
    state: {
      machineLocal: [
        "PUBLISH_DATA_DIR/x-profile (persistent browser profile)",
        "PUBLISH_DATA_DIR/x-cookies.json (sanitized auth-cookie cache)",
      ],
      durable: ["<data-repo>/.publish-cli/publish.db (watch dedupe and reply ledger)"],
      recovery: [
        "Do not copy cookies between machines; complete a headful login in the browser context that will continue the workflow.",
      ],
    },
    formats: [
      {
        id: "tweet",
        name: "Tweet / post",
        summary: "Plain-text native Unsent draft; standard posts use X's weighted 280 limit.",
        usage: "publish x draft --format tweet (--text <content> | --from <base.md|->) [--long] [--dry-run] [--inspect]",
        humanHighlights: [
          "Standard posts use twitter-text weighted length: 280 maximum, URLs count as 23, and CJK/parsed emoji sequences count as 2.",
          "Premium documents a 25,000 platform maximum, but its counting rule and maximum draftable length remain unknown; live drafts are confirmed only at 281 and 500.",
          "This transport does not attach media to tweet drafts.",
        ],
        action: "draft",
        platformSupported: true,
        transportSupport: "supported",
        fields: [
          { name: "text", required: true, description: "Inline text, Markdown file, or stdin." },
        ],
        terminalState: "native Unsent draft",
        constraints: {
          standardPost: {
            maxWeightedLength: fact(X_STANDARD_POST_MAX_WEIGHTED_LENGTH, "official_documentation", X_COUNTING_DOC, "2026-08-31"),
            measurement: fact("twitter_text_weighted", "official_documentation", X_COUNTING_DOC, "2026-08-31"),
            normalization: fact("NFC", "official_documentation", X_COUNTING_DOC, "2026-08-31"),
            latinAndCommonWeight: fact(1, "official_documentation", X_COUNTING_DOC, "2026-08-31"),
            cjkWeight: fact(2, "official_documentation", X_COUNTING_DOC, "2026-08-31"),
            parsedEmojiAndZwjSequenceWeight: fact(2, "official_documentation", X_COUNTING_DOC, "2026-08-31"),
            transformedUrlLength: fact(23, "official_documentation", X_COUNTING_DOC, "2026-08-31"),
            nativeDraftAtBoundary: fact(true, "live_positive_fixture", ISSUE_40, "2026-08-31"),
          },
          premiumLongPost: {
            platformMaxLength: fact(X_PREMIUM_POST_PLATFORM_MAX_LENGTH, "official_documentation", X_LONG_POST_DOC, "2026-08-31"),
            platformLengthMeasurement: unknown(ISSUE_40, "2026-08-31"),
            transportValidationPolicy: "25,000 Unicode code points (legacy local guard; not a confirmed platform measurement)",
            premiumRequired: fact(true, "official_documentation", X_LONG_POST_DOC, "2026-08-31"),
            documentedWebDraftSupport: fact(false, "official_documentation", X_LONG_POST_DOC, "2026-08-31"),
            liveWebDraftSupport: fact(true, "live_positive_fixture", ISSUE_40, "2026-08-31"),
            liveDraftFixtures: fact([281, 500], "live_positive_fixture", ISSUE_40, "2026-08-31"),
            maxDraftableLength: unknown(ISSUE_40, "2026-08-31"),
          },
          transportMedia: false,
        },
        validation: {
          local: "twitter-text weighted length",
          serverAuthoritative: ["Premium eligibility", "long-post draft acceptance beyond tested fixtures"],
        },
        workflow: {
          objective: "Stage one text post in X Unsent without posting it.",
          owner: "cli_transport",
          preconditions: [
            "readiness.ready is true after following any readiness.nextStep",
            "exactly one text source is prepared",
            "--long is used only for an eligible Premium account when a post exceeds weighted 280",
          ],
          steps: [
            {
              id: "preview",
              actor: "agent",
              instruction: "Run the advertised command with --dry-run, inspect the rendered text and weighted length, and correct any warning before staging.",
              verification: "The dry-run says no browser was touched and the intended complete post is shown without an over-limit warning.",
              evidenceRefs: ["constraints.standardPost"],
            },
            {
              id: "stage",
              actor: "cli",
              instruction: "Run the same command without --dry-run; open the authenticated X composer, enter the text, and save it to Unsent.",
              verification: "The command exits 0 and reports 'Staged a NATIVE X draft' with NEVER posted.",
              evidenceRefs: ["readiness", "constraints.standardPost.nativeDraftAtBoundary"],
            },
            {
              id: "confirm",
              actor: "agent",
              instruction: "Read the receipt and preserve any unconfirmed verification status instead of inferring success.",
              verification: "verified in Unsent/Drafts is yes, or the result is explicitly reported as unconfirmed for human inspection.",
              evidenceRefs: ["constraints.standardPost.nativeDraftAtBoundary"],
            },
          ],
          successCriteria: ["the command reports a native Unsent draft and verified=yes", "the complete intended text is visibly confirmed when verification is unconfirmed", "nothing was posted"],
          terminalBoundary: "Stop at the Unsent draft; never operate the final Post control.",
          stopConditions: [
            { id: "auth_not_ready", when: "readiness.ready is false", actor: "agent", action: "Follow readiness.nextStep and do not open the composer until positive auth proof exists.", outcome: "needs_human" },
            { id: "preview_invalid", when: "dry-run reports an over-limit or content warning that changes the intended post", actor: "agent", action: "Correct the supplied content and rerun dry-run; do not stage a partial/invalid post.", outcome: "abort" },
            { id: "stage_unconfirmed", when: "the command fails or reports verified=unconfirmed", actor: "agent", action: "Do not claim a saved draft; inspect Unsent visibly or report the result as unconfirmed.", outcome: "needs_human" },
            { id: "draft_verified", when: "the intended native Unsent draft is positively verified", actor: "agent", action: "Return the draft result and stop before Post.", outcome: "success_terminal" },
          ],
        },
        gotchas: [
          "The official web-draft statement conflicts with live Premium fixtures; 25,000 is a platform maximum, not a proven draftable maximum.",
        ],
      },
      {
        id: "thread",
        name: "Thread",
        summary: "Numbered plain-text sequence; every row independently uses X's weighted 280 limit.",
        usage: "publish x draft --format thread (--text <content> | --from <base.md|->) [--dry-run] [--inspect]",
        humanHighlights: [
          "Every numbered row independently uses the twitter-text weighted 280 limit.",
          "This transport does not attach media per row.",
        ],
        action: "draft",
        platformSupported: true,
        transportSupport: "supported",
        fields: [
          { name: "text", required: true, description: "Inline text, Markdown file, or stdin." },
        ],
        terminalState: "native multi-row Unsent draft",
        constraints: {
          perPostMaxWeightedLength: fact(X_STANDARD_POST_MAX_WEIGHTED_LENGTH, "official_documentation", X_COUNTING_DOC, "2026-08-31"),
          measurement: fact("twitter_text_weighted", "official_documentation", X_COUNTING_DOC, "2026-08-31"),
          transportMediaPerPost: false,
        },
        validation: {
          local: "twitter-text weighted length after numbering",
          serverAuthoritative: ["composer acceptance"],
        },
        workflow: {
          objective: "Stage a numbered multi-post thread in X Unsent without posting it.",
          owner: "cli_transport",
          preconditions: ["readiness.ready is true", "one canonical text source is prepared"],
          steps: [
            {
              id: "preview",
              actor: "agent",
              instruction: "Run the advertised command with --dry-run and review every numbered row and warning.",
              verification: "Every rendered row is at or below weighted 280 after numbering and the sequence preserves the intended content.",
              evidenceRefs: ["constraints.perPostMaxWeightedLength", "constraints.measurement"],
            },
            {
              id: "stage",
              actor: "cli",
              instruction: "Run without --dry-run; add each rendered row to the X thread composer and save the thread to Unsent.",
              verification: "The command exits 0 and reports the expected post count in a native X thread draft.",
              evidenceRefs: ["readiness", "constraints.perPostMaxWeightedLength"],
            },
            {
              id: "confirm",
              actor: "agent",
              instruction: "Treat the first-row match as bounded verification and request visible review when every row must be proven after reopen.",
              verification: "The receipt says verified yes for the staged prefix, with the every-row limitation retained.",
              evidenceRefs: ["constraints.perPostMaxWeightedLength"],
            },
          ],
          successCriteria: ["the command reports the expected row count", "the first-row receipt is treated as bounded evidence and every row is visibly confirmed when full persistence proof is required", "nothing was posted"],
          terminalBoundary: "Stop at the multi-row Unsent draft; never operate Post all.",
          stopConditions: [
            { id: "auth_not_ready", when: "readiness.ready is false", actor: "agent", action: "Follow readiness.nextStep before staging.", outcome: "needs_human" },
            { id: "preview_invalid", when: "any numbered row exceeds weighted 280 or the reconstructed sequence is incomplete", actor: "agent", action: "Correct or re-split the input; do not stage.", outcome: "abort" },
            { id: "stage_unconfirmed", when: "the command fails, row count differs, or only the first-row receipt is insufficient for the task", actor: "agent", action: "Do not claim every row persisted; inspect the native draft visibly or report bounded verification only.", outcome: "needs_human" },
            { id: "draft_verified", when: "the expected multi-row draft is confirmed to the required evidence level", actor: "agent", action: "Return the bounded result and stop before Post all.", outcome: "success_terminal" },
          ],
        },
        gotchas: ["Verification currently matches the first staged row, not every row after reopen."],
      },
      {
        id: "article",
        name: "Article",
        summary: "Premium rich Article with optional auto-discovery of an already-prepared cover; autosaves as an Article draft.",
        usage: "publish x draft --format article --from <base.md> [--dry-run] [--inspect]",
        humanHighlights: [
          "Premium is required; the Article body maximum remains unknown.",
          "JPEG, PNG, and WebP covers are live-positive fixtures at 1500x600 and 1500x620; every tested upload required crop/apply.",
          "Cover discovery scans the --from directory, ranks 5:2 images first, then names containing hero/cover/banner/og/5x2/5-2, then closest ratio; there is no explicit cover flag.",
          "Article title comes from the first Markdown H1, otherwise the first non-empty line, otherwise Untitled.",
          "Cover byte/dimension/aspect maxima remain unknown; title, representative body formatting, and cover presence survived a reopen fixture.",
        ],
        action: "draft",
        platformSupported: true,
        transportSupport: "supported",
        fields: [
          { name: "from", required: true, description: "Canonical Markdown file." },
          {
            name: "coverAsset",
            required: false,
            description: "Optional already-prepared .jpg/.jpeg/.png/.webp cover auto-discovered in the --from file's directory; a coverless Article draft can still autosave.",
          },
        ],
        terminalState: "autosaved native Article draft",
        constraints: {
          premiumRequired: fact(true, "official_documentation", X_ARTICLE_DOC, "2026-08-31"),
          bodyMaximum: unknown(ISSUE_40, "2026-08-31"),
          cover: {
            positiveAcceptedMimeTypes: fact(
              ["image/jpeg", "image/png", "image/webp"],
              "live_positive_fixture",
              ISSUE_40,
              "2026-08-31",
            ),
            acceptedMimeTypesExhaustive: unknown(ISSUE_40, "2026-08-31"),
            transportPolicyExtensions: [...X_ARTICLE_COVER_POSITIVE_EXTENSIONS],
            recommendedAspectRatio: fact("5:2", "live_positive_fixture", ISSUE_40, "2026-08-31"),
            testedDimensions: fact(
              [{ width: 1500, height: 600 }, { width: 1500, height: 620 }],
              "live_positive_fixture",
              ISSUE_40,
              "2026-08-31",
            ),
            cropApplyRequiredForEveryTestedUpload: fact(true, "live_positive_fixture", ISSUE_40, "2026-08-31"),
            maximumBytes: unknown(ISSUE_40, "2026-08-31"),
            minimumDimensions: unknown(ISSUE_40, "2026-08-31"),
            maximumDimensions: unknown(ISSUE_40, "2026-08-31"),
            acceptedAspectRatioRange: unknown(ISSUE_40, "2026-08-31"),
            pixelExactPersistedCropFidelity: unknown(ISSUE_40, "2026-08-31"),
            otherServerTransformations: unknown(ISSUE_40, "2026-08-31"),
          },
          persistence: {
            reopened: fact(true, "live_positive_fixture", ISSUE_40, "2026-08-31"),
            title: fact(true, "live_positive_fixture", ISSUE_40, "2026-08-31"),
            representativeBodyText: fact(true, "live_positive_fixture", ISSUE_40, "2026-08-31"),
            boldSpan: fact(true, "live_positive_fixture", ISSUE_40, "2026-08-31"),
            twoItemUnorderedList: fact(true, "live_positive_fixture", ISSUE_40, "2026-08-31"),
            coverPresence: fact(true, "live_positive_fixture", ISSUE_40, "2026-08-31"),
          },
        },
        validation: {
          local: ["optional adjacent cover auto-discovery", "live-positive extension recognition"],
          serverAuthoritative: ["all unknown cover boundaries", "Article body limits", "Premium eligibility"],
        },
        workflow: {
          objective: "Stage an autosaved Premium X Article draft from canonical Markdown.",
          owner: "cli_transport",
          preconditions: [
            "readiness.ready is true and the account is eligible for Articles",
            "the Markdown file contains the intended title/body",
            "when a cover is wanted, an already-prepared JPEG/PNG/WebP is placed beside the Markdown; 5:2 is preferred",
          ],
          steps: [
            {
              id: "prepare",
              actor: "agent",
              instruction: "Put the canonical Markdown and optional prepared cover in the same directory; name the cover with hero/cover/banner/og/5x2/5-2 when multiple images exist.",
              verification: "The title resolves from H1/first line and the intended cover wins the documented discovery order.",
              evidenceRefs: ["constraints.cover"],
            },
            {
              id: "preview",
              actor: "agent",
              instruction: "Run the advertised command with --dry-run and inspect the generated Article artifact and downgrade warnings.",
              verification: "The dry-run artifact contains the complete intended Markdown and no browser was touched.",
              evidenceRefs: ["constraints.bodyMaximum"],
            },
            {
              id: "stage",
              actor: "cli",
              instruction: "Run without --dry-run; populate the Article editor, upload the discovered cover when present, apply X's crop dialog, and let the Article autosave.",
              verification: "The command exits 0, returns an Article editor id/URL, and reports a native Article draft.",
              evidenceRefs: ["readiness", "constraints.premiumRequired", "constraints.cover.cropApplyRequiredForEveryTestedUpload"],
            },
            {
              id: "reopen",
              actor: "agent",
              instruction: "When persistence matters, reopen the returned Article and inspect title, representative body formatting, and cover presence.",
              verification: "Title, representative body text/formatting, and the expected cover are present; pixel-exact crop fidelity remains unknown.",
              evidenceRefs: ["constraints.persistence", "constraints.cover.pixelExactPersistedCropFidelity"],
            },
          ],
          successCriteria: ["an autosaved native Article editor id/URL exists", "title/body and supplied cover presence are visibly verified after reopen when persistence is required", "nothing was published"],
          terminalBoundary: "Stop in the Article editor after autosave/reopen verification; never operate Publish.",
          stopConditions: [
            { id: "auth_or_eligibility_missing", when: "auth is not ready or the account lacks Article eligibility", actor: "agent", action: "Follow the auth/Premium handoff; do not substitute another public format silently.", outcome: "needs_human" },
            { id: "preview_invalid", when: "dry-run reveals missing content or an unacceptable downgrade", actor: "agent", action: "Correct the Markdown/asset before browser staging.", outcome: "abort" },
            { id: "stage_or_reopen_mismatch", when: "no editor id is returned or reopened title/body/cover does not match", actor: "agent", action: "Do not claim persistence; preserve the observed mismatch for inspection/correction.", outcome: "needs_human" },
            { id: "draft_verified", when: "the autosaved Article and required reopened fields are confirmed", actor: "agent", action: "Return the draft URL and stop before Publish.", outcome: "success_terminal" },
          ],
        },
        gotchas: ["Every tested cover—including exact 5:2—opened crop/edit and required Apply."],
      },
    ],
    gotchas: ["Media and long-post claims are bounded to the named transport surfaces and fixtures."],
    forbiddenActions: ["Post", "Publish", "schedule publication"],
  },

  linkedin: {
    schemaVersion: CHANNEL_CAPABILITY_SCHEMA_VERSION,
    channel: "linkedin",
    displayName: "LinkedIn",
    executionMode: "cli_transport",
    supportBoundary: "Stages one native personal feed-post draft through Save as draft; never clicks Post.",
    responsibility: {
      cli: [
        "Passively report authentication readiness, convert supplied Markdown to deterministic plain text, attach supplied local images, and invoke Save as draft.",
      ],
      agent: [
        "Prepare the post and images, resolve readiness, run the draft command, and treat media persistence as unconfirmed unless visibly checked.",
      ],
      human: [
        "Complete login/checkpoints, review restored text and media, resolve any link-preview choice, and make the final Post decision.",
      ],
      platform: [
        "Enforce account/server rules, lay out or crop images, resolve link-preview/media interaction, and persist the native draft.",
      ],
      rationale: [
        "LinkedIn exposes a single personal-post draft surface, so the CLI supports that bounded format rather than unrelated article, newsletter, company-page, or scheduling flows.",
        "Conflicting documented and live media limits remain server-authoritative instead of becoming guessed local blockers.",
      ],
    },
    excludedCapabilities: [
      {
        id: "public_send",
        disposition: "intentionally_excluded",
        reason: "The final Post control is the human approval boundary.",
        owner: "human",
        alternative: "Reopen and review the saved personal-post draft, then post manually if approved.",
      },
      {
        id: "non_personal_post_surfaces",
        disposition: "deferred",
        reason: "Articles, newsletters, company-page posts, video, documents, and scheduling use different unverified composer contracts.",
        owner: "human",
        alternative: "Use LinkedIn's native UI for those surfaces.",
      },
      {
        id: "asset_transformation",
        disposition: "intentionally_excluded",
        reason: "The CLI attaches caller-supplied images without redesigning or normalizing them.",
        owner: "agent",
        alternative: "Prepare images to the desired layout before running the draft command.",
      },
    ],
    auth: {
      mode: "passive persistent-profile browser probe",
      entryUrl: "https://www.linkedin.com/feed/",
      workflowRef: GENERIC_CAPABILITY_WORKFLOW_REF,
      continueInSameContext: true,
    },
    state: {
      machineLocal: [
        "PUBLISH_DATA_DIR/li-profile (persistent browser profile)",
        "PUBLISH_DATA_DIR/li-cookies.json (auth-cookie cache)",
      ],
      durable: [],
      recovery: [
        "Do not copy cookies between machines; complete a headful login/checkpoint in the browser context that will continue the workflow.",
      ],
    },
    formats: [
      {
        id: "post",
        name: "Personal feed post",
        summary: "One plain-text post with optional images; text is capped at 3,000 UTF-16 code units.",
        usage: "publish linkedin draft (--text <content> | --from <base.md|->) [--media <path> ...] [--bold] [--dry-run] [--inspect]",
        humanHighlights: [
          "Text is capped at 3,000 UTF-16 code units.",
          "Official image guidance says up to 20 images, 5 MB each, minimum 552x276, and 3:1 through 4:5; newer live fixtures accepted at least 21 images, >5 MB, smaller dimensions, WebP, and 4:1/3:5, so actual maxima/range remain unknown.",
          "The editor used object-fit contain with no automatic crop in the fixtures; manual crop presets observed were original, 1:1, 3:4, 4:1, and 16:9.",
          "JPEG, PNG, GIF, and WebP are live-positive image types, but documented count/byte/dimension/ratio boundaries conflict with live acceptance; actual maxima remain unknown.",
          "Text restoration is live-confirmed; media draft save/persistence remains unknown.",
        ],
        action: "draft",
        platformSupported: true,
        transportSupport: "supported",
        fields: [
          { name: "text", required: true, description: "Inline text, Markdown file, or stdin." },
          { name: "media", required: false, description: "Repeatable local image path." },
        ],
        terminalState: "native personal-post draft",
        constraints: {
          text: {
            maxUtf16CodeUnits: fact(LINKEDIN_POST_MAX_UTF16_CODE_UNITS, "live_positive_fixture", ISSUE_41, "2026-09-01"),
            measurement: fact("utf16_code_units", "live_positive_fixture", ISSUE_41, "2026-09-01"),
            overLimitBehavior: fact("input_retained_post_disabled", "live_positive_fixture", ISSUE_41, "2026-09-01"),
            documentedMaximumCharacters: fact(3000, "official_documentation", LINKEDIN_POST_DOC, "2026-08-31"),
          },
          images: {
            acceptedMimeTypesLive: fact(
              ["image/jpeg", "image/png", "image/gif", "image/webp"],
              "live_positive_fixture",
              ISSUE_41,
              "2026-09-01",
            ),
            documentedDesktopMimeTypes: fact(
              ["image/jpeg", "image/png", "image/gif"],
              "official_documentation",
              LINKEDIN_TYPES_DOC,
              "2026-08-31",
            ),
            actualMaximumCount: unknown(ISSUE_41, "2026-09-01"),
            documentedMaximumCount: fact(20, "official_documentation", LINKEDIN_MEDIA_DOC, "2026-08-31"),
            observedAcceptedCountAtLeast: fact(21, "live_positive_fixture", ISSUE_41, "2026-09-01"),
            observedNextToComposerCountAtLeast: fact(21, "live_positive_fixture", ISSUE_41, "2026-09-01"),
            actualMaximumBytesPerImage: unknown(ISSUE_41, "2026-09-01"),
            documentedMaximumBytesLabel: fact("5 MB", "official_documentation", LINKEDIN_MEDIA_DOC, "2026-08-31"),
            observedAcceptedBytesAtLeast: fact(5246142, "live_positive_fixture", ISSUE_41, "2026-09-01"),
            actualMinimumDimensions: unknown(ISSUE_41, "2026-09-01"),
            actualMaximumDimensions: unknown(ISSUE_41, "2026-09-01"),
            documentedMinimumDimensions: fact(
              { width: 552, height: 276 },
              "official_documentation",
              LINKEDIN_MEDIA_DOC,
              "2026-08-31",
            ),
            documentedMaximumPixels: fact(36000000, "official_documentation", LINKEDIN_TYPES_DOC, "2026-08-31"),
            observedAcceptedBelowDocumentedMinimum: fact(
              [{ width: 551, height: 276 }, { width: 552, height: 275 }],
              "live_positive_fixture",
              ISSUE_41,
              "2026-09-01",
            ),
            actualAcceptedAspectRatioRange: unknown(ISSUE_41, "2026-09-01"),
            documentedAspectRatioRange: fact(
              { widest: "3:1", tallest: "4:5" },
              "official_documentation",
              LINKEDIN_MEDIA_DOC,
              "2026-08-31",
            ),
            observedEditorRatios: fact(["3:1", "4:5", "4:1", "3:5"], "live_positive_fixture", ISSUE_41, "2026-09-01"),
            automaticCropObserved: fact(false, "live_positive_fixture", ISSUE_41, "2026-09-01"),
            editorPreviewObjectFit: fact("contain", "live_positive_fixture", ISSUE_41, "2026-09-01"),
            manualCropPresets: fact(["original", "1:1", "3:4", "4:1", "16:9"], "live_positive_fixture", ISSUE_41, "2026-09-01"),
          },
          documentedVsLiveConflicts: fact(
            ["WebP desktop acceptance", "20-image count", "5 MB bytes", "552x276 minimum", "3:1 through 4:5 ratio range"],
            "live_positive_fixture",
            ISSUE_41,
            "2026-09-01",
          ),
          linkPreview: {
            imagePreviewMutualExclusionDocumented: fact(true, "official_documentation", LINKEDIN_MEDIA_DOC, "2026-08-31"),
            replacementBehaviorLive: unknown(ISSUE_41, "2026-09-01"),
          },
          draft: {
            nativeSaveAffordanceDocumented: fact(true, "official_documentation", LINKEDIN_DRAFT_DOC, "2026-08-31"),
            textRestoreObserved: fact(true, "live_positive_fixture", ISSUE_41, "2026-09-01"),
            successfulMediaSaveObserved: fact(false, "live_positive_fixture", ISSUE_41, "2026-09-01"),
            mediaPersistence: unknown(ISSUE_41, "2026-09-01"),
            mediaRestoreCount: unknown(ISSUE_41, "2026-09-01"),
            mediaRestoreOrder: unknown(ISSUE_41, "2026-09-01"),
            firstImageLayoutAfterRestore: unknown(ISSUE_41, "2026-09-01"),
          },
        },
        validation: {
          local: ["3,000 UTF-16 code-unit text cap", "media file existence"],
          serverAuthoritative: ["actual image maxima", "media draft persistence", "link-preview interaction"],
        },
        workflow: {
          objective: "Stage one native LinkedIn personal-post draft without posting it.",
          owner: "cli_transport",
          preconditions: ["readiness.ready is true", "one text source and any already-prepared image files are available"],
          steps: [
            {
              id: "preview",
              actor: "agent",
              instruction: "Run the advertised command with --dry-run and review the deterministic plain-text rendering, UTF-16 length, links, and media order.",
              verification: "The complete intended post is shown at or below 3,000 UTF-16 code units and no browser was touched.",
              evidenceRefs: ["constraints.text", "constraints.images"],
            },
            {
              id: "stage",
              actor: "cli",
              instruction: "Run without --dry-run; clear any auto-restored stale draft, enter the text, attach images in flag order, dismiss, and choose Save as draft.",
              verification: "The command exits 0 and reports a native LinkedIn draft with NEVER posted.",
              evidenceRefs: ["readiness", "constraints.draft.nativeSaveAffordanceDocumented"],
            },
            {
              id: "reopen",
              actor: "agent",
              instruction: "Reopen the composer and compare the restored text; if media was requested, visibly inspect count/order instead of relying on the current receipt.",
              verification: "Text prefix restoration matches; requested media is either visibly confirmed or explicitly reported as unconfirmed.",
              evidenceRefs: ["constraints.draft"],
            },
          ],
          successCriteria: ["the intended text is restored from a native personal-post draft", "when media was requested, its count/order is visibly confirmed rather than inferred", "nothing was posted"],
          terminalBoundary: "Stop after Save as draft and bounded reopen verification; never operate Post.",
          stopConditions: [
            { id: "auth_not_ready", when: "readiness.ready is false", actor: "agent", action: "Follow readiness.nextStep before opening the composer.", outcome: "needs_human" },
            { id: "preview_invalid", when: "text exceeds 3,000 UTF-16 code units or a media path is missing", actor: "agent", action: "Correct the caller-supplied input; do not rely on truncation or guessed media maxima.", outcome: "abort" },
            { id: "save_or_media_unconfirmed", when: "Save as draft fails, text does not restore, or requested media count/order is not visibly confirmed", actor: "agent", action: "Do not claim the complete draft; request visible human inspection or report unconfirmed media.", outcome: "needs_human" },
            { id: "draft_verified", when: "restored text and all requested media are confirmed", actor: "agent", action: "Return the native-draft result and stop before Post.", outcome: "success_terminal" },
          ],
        },
        gotchas: [
          "Documented media boundaries conflict with newer live acceptance; they are guidance, not local hard maxima.",
          "A bounded media Save as draft attempt did not complete, so media persistence remains unknown.",
        ],
      },
    ],
    gotchas: ["LinkedIn auto-restores the last text draft when its composer opens."],
    forbiddenActions: ["Post"],
  },

  reddit: {
    schemaVersion: CHANNEL_CAPABILITY_SCHEMA_VERSION,
    channel: "reddit",
    displayName: "Reddit",
    executionMode: "cli_transport",
    supportBoundary: "Stages a native Markdown self-post draft after a separate live subreddit-contract inspection; never posts.",
    responsibility: {
      cli: [
        "Report passive auth readiness, inspect live subreddit posting contracts on request, validate the self-post inputs, switch the composer to Markdown, and save a native draft.",
      ],
      agent: [
        "Choose the destination, run inspect, satisfy current rules/flair requirements, prepare title/body, invoke draft, and inspect any live eligibility failure.",
      ],
      human: [
        "Complete CAPTCHA/login, review the saved self-post and community fit, and make the final Post decision.",
      ],
      platform: [
        "Return current community rules/flairs, enforce account eligibility and AutoMod behavior, render Markdown, and persist the native draft.",
      ],
      rationale: [
        "Subreddit contracts are dynamic, so static info explains the inspection step but never freezes community-specific rules.",
        "Only Markdown self-posts are transported; image/gallery/link-post composers have different contracts.",
      ],
    },
    excludedCapabilities: [
      {
        id: "public_send",
        disposition: "intentionally_excluded",
        reason: "The final Post control is the human approval boundary.",
        owner: "human",
        alternative: "Review the native self-post draft and submit manually if approved.",
      },
      {
        id: "image_gallery_link_posts",
        disposition: "deferred",
        reason: "This adapter implements only the Markdown self-post composer and cannot upload inline body images.",
        owner: "human",
        alternative: "Use Reddit's native image/gallery/link-post workflow when that format is required.",
      },
      {
        id: "editorial_routing",
        disposition: "external",
        reason: "The CLI reports subreddit facts but does not judge audience fit or choose a community/flair.",
        owner: "agent",
        alternative: "Use inspect results and editorial context to select the destination and flair.",
      },
    ],
    auth: {
      mode: "passive persistent-profile browser probe",
      entryUrl: "https://www.reddit.com/",
      workflowRef: GENERIC_CAPABILITY_WORKFLOW_REF,
      continueInSameContext: true,
    },
    state: {
      machineLocal: [
        "PUBLISH_DATA_DIR/reddit-profile (persistent browser profile)",
        "PUBLISH_DATA_DIR/reddit-cookies.json (auth-cookie cache)",
      ],
      durable: [],
      recovery: [
        "Do not copy cookies between machines; complete CAPTCHA/login in a headful browser context, then continue in that context.",
      ],
    },
    formats: [
      {
        id: "self_post",
        name: "Self-post",
        summary: "Markdown title/body draft for one subreddit; no inline body-image transport.",
        usage: "publish reddit draft --subreddit <name> --title <title> (--text <body> | --from <base.md|->) [--flair <id|text>] [--nsfw] [--spoiler] [--dry-run] [--inspect]",
        humanHighlights: [
          "The transport guard uses 300 title and 40,000 body code points; actual platform maxima remain unknown.",
          "Run publish reddit inspect <subreddit> for current rules/flairs; karma, account age, bans, and complete AutoMod behavior are not statically knowable.",
          "The body remains Markdown and this self-post transport does not upload inline body images.",
        ],
        action: "draft",
        platformSupported: true,
        transportSupport: "supported",
        fields: [
          { name: "subreddit", required: true, description: "Destination subreddit." },
          { name: "title", required: true, description: "Post title." },
          { name: "text", required: true, description: "Inline text, Markdown file, or stdin." },
          { name: "flair", required: false, description: "Live destination-specific flair id or text." },
          { name: "nsfw", required: false, description: "Mark the draft NSFW." },
          { name: "spoiler", required: false, description: "Mark the draft as a spoiler." },
        ],
        terminalState: "native self-post draft verified by Draft saved toast",
        constraints: {
          transportContract: {
            configuredTitleLimitCodePoints: 300,
            configuredBodyLimitCodePoints: 40000,
            bodyFormat: "markdown",
            inlineBodyImagesTransported: false,
          },
          platformLimits: {
            actualTitleMaximumCodePoints: unknown(ISSUE_43, "2026-08-30"),
            actualBodyMaximumCodePoints: unknown(ISSUE_43, "2026-08-30"),
          },
          dynamicCommunityContract: {
            evidenceStatus: fact("live destination contract; never frozen into static per-subreddit rules", "read_only_api", ISSUE_43, "2026-08-30"),
            inspectable: {
              command: "publish reddit inspect <subreddit>",
              fields: [
                "allowed submission types",
                "subreddit rules",
                "required flair and templates",
                "title regexes",
                "required or blacklisted strings",
                "body restrictions",
              ],
            },
            composerOnly: [
              "karma eligibility",
              "account-age eligibility",
              "restricted-community eligibility",
              "ban state",
              "approved-submitter state",
            ],
            unverifiableStatically: [
              "complete AutoMod behavior",
            ],
          },
        },
        validation: {
          local: ["static title/body shape"],
          serverAuthoritative: ["composer-only eligibility", "complete AutoMod behavior"],
          staticRegistryPolicy: "Dynamic destination rules are never copied into static info.",
        },
        workflow: {
          objective: "Stage one Markdown self-post in the target subreddit's native Drafts without posting it.",
          owner: "cli_transport",
          preconditions: ["a destination subreddit, title, body, and any required flair are prepared", "readiness.ready is required only before the real draft run; inspect and dry-run can precede login"],
          steps: [
            {
              id: "inspect_destination",
              actor: "agent",
              instruction: "Run publish reddit inspect <subreddit>; choose a permitted self-post type and satisfy current rules, title/body requirements, and flair/template requirements.",
              verification: "The live inspection identifies self-posts as allowed and no known destination requirement is unresolved.",
              evidenceRefs: ["constraints.dynamicCommunityContract"],
            },
            {
              id: "preview",
              actor: "agent",
              instruction: "Run the advertised draft command with --dry-run and inspect the exact Markdown/title; remember that dry-run skips the live subreddit preflight.",
              verification: "Local generation passes and the printed Markdown is complete; no browser was touched.",
              evidenceRefs: ["constraints.platformLimits"],
            },
            {
              id: "establish_readiness",
              actor: "agent",
              instruction: "Before the real draft run, follow readiness.nextStep until readiness.ready is true; inspect/dry-run do not themselves prove authenticated composer eligibility.",
              verification: "The authenticated Reddit user menu is positively observed and any CAPTCHA/challenge is complete.",
              evidenceRefs: ["readiness", "auth"],
            },
            {
              id: "stage",
              actor: "cli",
              instruction: "Run without --dry-run; fetch the live contract, stop on violations/eligibility blocks, switch to Markdown mode, fill the composer, and choose Save Draft.",
              verification: "The command exits 0, reports the target subreddit/flair, and observes the Draft saved toast.",
              evidenceRefs: ["readiness", "constraints.dynamicCommunityContract"],
            },
            {
              id: "confirm",
              actor: "agent",
              instruction: "Preserve any live/AutoMod uncertainty and treat a missing Draft saved signal as failure.",
              verification: "verified in drafts is yes; otherwise report that nothing was proven saved.",
              evidenceRefs: ["constraints.dynamicCommunityContract"],
            },
          ],
          successCriteria: ["the intended composer state was submitted to Save Draft", "the Draft saved toast was observed", "no stronger reopen/persistence claim is made", "nothing was posted"],
          terminalBoundary: "Stop after Save Draft toast verification; never operate Post.",
          stopConditions: [
            { id: "contract_rejected", when: "inspect or live preflight rejects the post type, flair, title, or body", actor: "agent", action: "Correct the destination contract violation; do not open/fill through to save.", outcome: "abort" },
            { id: "auth_or_eligibility_blocked", when: "auth is not ready or the composer reports karma, age, ban, restricted, or approved-submitter ineligibility", actor: "agent", action: "Stop and surface the exact bounded blocker; never bypass it.", outcome: "needs_human" },
            { id: "save_unconfirmed", when: "Save Draft is unavailable or the Draft saved toast is absent", actor: "agent", action: "Treat the run as failure and do not claim persistence.", outcome: "abort" },
            { id: "draft_saved", when: "the Draft saved toast is observed for the intended composer state", actor: "agent", action: "Return the bounded saved-toast receipt and stop before Post.", outcome: "success_terminal" },
          ],
        },
        gotchas: ["Run reddit inspect for current destination facts; complete AutoMod behavior is unknowable statically."],
      },
    ],
    gotchas: ["The first authenticated login is CAPTCHA-heavy and may require a human challenge."],
    forbiddenActions: ["Post"],
  },

  wechat: {
    schemaVersion: CHANNEL_CAPABILITY_SCHEMA_VERSION,
    channel: "wechat",
    displayName: "WeChat Official Account",
    executionMode: "cli_transport",
    supportBoundary: "Calls stable_token, uploadimg, permanent material upload, and draft/add only; never calls publish or mass-message endpoints.",
    responsibility: {
      cli: [
        "Probe API readiness, render supplied Markdown as inline-styled HTML, upload local body images and the required cover, rewrite body image URLs, and call draft/add.",
        "Convert non-WeChat external links to bottom citations by default and report a sanitized draft receipt.",
      ],
      agent: [
        "Prepare canonical content and assets, configure fixed egress and credentials, run readiness/dry-run/draft, and inspect the 草稿箱 preview.",
      ],
      human: [
        "Provision Official Account credentials, QR-authorize IP allowlist changes, review the 草稿箱 preview, and make any later publication decision in the official console.",
      ],
      platform: [
        "Mint tokens, enforce the source-IP allowlist and unknown 字/media/HTML limits, sanitize HTML, crop cover presentations, store materials, and persist the draft.",
      ],
      rationale: [
        "WeChat offers an official draft API, so the CLI uses that API instead of browser automation.",
        "Draft creation and publication are structurally separate endpoints; publish and mass-message endpoints are deliberately absent.",
      ],
    },
    excludedCapabilities: [
      {
        id: "public_send",
        disposition: "intentionally_excluded",
        reason: "freepublish and mass-message endpoints cross the human approval boundary and are structurally forbidden.",
        owner: "human",
        alternative: "Review the 草稿箱 draft and use the official console for any explicitly authorized publication.",
      },
      {
        id: "cover_design_and_crop",
        disposition: "intentionally_excluded",
        reason: "The CLI uploads the supplied cover but does not design, resize, or choose its crop.",
        owner: "agent",
        alternative: "Prepare the cover before invocation and inspect WeChat's 2.35:1 and 1:1 crop presentations in the draft preview.",
      },
      {
        id: "non_news_materials",
        disposition: "deferred",
        reason: "The implemented draft contract is one article_type=news article.",
        owner: "human",
        alternative: "Use the Official Account console for other material/message formats.",
      },
    ],
    auth: {
      mode: "API credentials, stable token, and fixed allowlisted egress",
      entryUrl: "https://developers.weixin.qq.com/platform/",
      workflowRef: GENERIC_CAPABILITY_WORKFLOW_REF,
      continueInSameContext: false,
    },
    state: {
      machineLocal: [
        "PUBLISH_DATA_DIR/wechat-token.json (short-lived stable-token cache; no browser profile)",
      ],
      durable: [],
      recovery: [
        "Set WECHAT_APP_ID and WECHAT_APP_SECRET; set exactly one of WECHAT_PROXY_URL or WECHAT_SSH_TUNNEL for fixed egress.",
        "Allowlist that fixed egress IP once in the developer console; token renewal may create/update the machine-local cache and is reported in readiness.healed.",
      ],
    },
    formats: [
      {
        id: "article",
        name: "Official Account news article",
        summary: "Inline-styled HTML article staged in 草稿箱 through draft/add with a required permanent cover.",
        usage: "publish wechat draft (--from <base.md|-> | --text <content>) [--title <title>] [--author <name>] [--digest <summary>] [--cover <image>] [--source-url <url>] [--keep-links] [--out <file.html>] [--dry-run]",
        humanHighlights: [
          "Cover formats: BMP/PNG/JPEG/JPG/GIF with documented label 10M; body images: JPG/PNG with documented wording 1MB以下. Exact byte boundaries are unknown/server-authoritative.",
          "Path resolution: body images and frontmatter covers are relative to the --from Markdown directory; with --text or stdin they are relative to the current working directory; absolute paths are accepted. A --cover flag is relative to the invocation working directory.",
          "WeChat documents cover crop presentations at 2.35:1 and 1:1, but the required input ratio, dimensions, default crop, and recompression behavior remain unknown/server-authoritative.",
          "Documented title/author/digest limits are 32/16/120 字; measurement is unknown/server-authoritative, and omitted digest lets WeChat derive the first 54 字.",
          "Three documented HTML-size statements conflict, so the effective maximum is unknown.",
          "Fresh cover uploads consume permanent-material quota; body uploadimg images do not.",
        ],
        action: "draft",
        platformSupported: true,
        transportSupport: "supported",
        fields: [
          { name: "title", required: true, description: "Required after resolution: --title, frontmatter title, or leading Markdown H1." },
          { name: "text", required: true, description: "Exactly one of --from <Markdown|-> or --text <content>." },
          { name: "cover", required: true, description: "Required after resolution: --cover or frontmatter coverImage/cover/image; uploaded as permanent material." },
          { name: "author", required: false, description: "--author, frontmatter author, or WECHAT_AUTHOR." },
          { name: "digest", required: false, description: "--digest or frontmatter description/summary/digest; omission lets WeChat derive it." },
          { name: "sourceUrl", required: false, description: "--source-url or frontmatter sourceUrl/contentSourceUrl." },
          { name: "keepLinks", required: false, description: "Keep inline external links instead of the default bottom-citation rewrite; platform sanitization still applies." },
          { name: "out", required: false, description: "Write pre-upload inline-styled HTML for inspection; local body-image paths are not yet CDN-rewritten." },
        ],
        terminalState: "native Official Account 草稿箱 draft via draft/add",
        constraints: {
          articleType: fact("news", "official_documentation", WECHAT_DRAFT_DOC, "2026-08-31"),
          cover: {
            requiredPermanentMediaId: fact(true, "official_documentation", WECHAT_DRAFT_DOC, "2026-08-31"),
            acceptedFormats: fact(["BMP", "PNG", "JPEG", "JPG", "GIF"], "official_documentation", WECHAT_COVER_DOC, "2026-08-31"),
            documentedMaximumBytesLabel: fact("10M", "official_documentation", WECHAT_COVER_DOC, "2026-08-31"),
            exactMaximumBytes: unknown(ISSUE_42, "2026-08-31"),
            transportPolicyExtensions: [...WECHAT_COVER_EXTENSIONS],
            minimumDimensions: unknown(ISSUE_42, "2026-08-31"),
            recommendedDimensions: unknown(ISSUE_42, "2026-08-31"),
            maximumDimensions: unknown(ISSUE_42, "2026-08-31"),
            requiredInputAspectRatio: unknown(ISSUE_42, "2026-08-31"),
            supportedCropRatios: fact(["2.35:1", "1:1"], "official_documentation", WECHAT_DRAFT_DOC, "2026-08-31"),
            defaultCropBehavior: unknown(ISSUE_42, "2026-08-31"),
            gifAnimationPersistence: unknown(ISSUE_42, "2026-08-31"),
          },
          bodyImages: {
            acceptedFormats: fact(["JPG", "PNG"], "official_documentation", WECHAT_BODY_IMAGE_DOC, "2026-08-31"),
            documentedMaximumBytesWording: fact("1MB以下", "official_documentation", WECHAT_BODY_IMAGE_DOC, "2026-08-31"),
            exactMaximumBytes: unknown(ISSUE_42, "2026-08-31"),
            transportPolicyExtensions: [...WECHAT_BODY_IMAGE_EXTENSIONS],
            pixelDimensions: unknown(ISSUE_42, "2026-08-31"),
            maximumCountForNewsHtml: unknown(ISSUE_42, "2026-08-31"),
            recompressionAndMetadataBehavior: unknown(ISSUE_42, "2026-08-31"),
            countsAgainstPermanentImageQuota: fact(false, "official_documentation", WECHAT_BODY_IMAGE_DOC, "2026-08-31"),
          },
          textFields: {
            title: {
              documentedMaximumZi: fact(32, "official_documentation", WECHAT_DRAFT_DOC, "2026-08-31"),
              measurement: unknown(ISSUE_42, "2026-08-31"),
              enforcement: "server_authoritative",
            },
            author: {
              documentedMaximumZi: fact(16, "official_documentation", WECHAT_DRAFT_DOC, "2026-08-31"),
              measurement: unknown(ISSUE_42, "2026-08-31"),
              enforcement: "server_authoritative",
            },
            digest: {
              documentedMaximumZi: fact(120, "official_documentation", WECHAT_DRAFT_DOC, "2026-08-31"),
              measurement: unknown(ISSUE_42, "2026-08-31"),
              omittedBehaviorFirstBodyZi: fact(54, "official_documentation", WECHAT_DRAFT_DOC, "2026-08-31"),
              enforcement: "server_authoritative",
            },
          },
          htmlContent: {
            conflictingDocumentedStatements: fact(
              ["not over 2 kb", "fewer than 20,000 characters", "under 1 MB"],
              "official_documentation",
              WECHAT_DRAFT_DOC,
              "2026-08-31",
            ),
            effectiveMaximum: unknown(ISSUE_42, "2026-08-31"),
            javascriptRemoved: fact(true, "official_documentation", WECHAT_DRAFT_DOC, "2026-08-31"),
            externalImagesFilteredUnlessUploaded: fact(true, "official_documentation", WECHAT_DRAFT_DOC, "2026-08-31"),
          },
          sourceUrl: {
            documentedMaximumBytesLabel: fact("1 kb", "official_documentation", WECHAT_DRAFT_DOC, "2026-08-31"),
            exactMaximumBytes: unknown(ISSUE_42, "2026-08-31"),
          },
          pathResolution: {
            markdownRelativeBodyImages: fact("directory containing the --from Markdown file", "implementation_contract", "src/commands/wechat-draft.ts", "2026-09-01"),
            markdownRelativeFrontmatterCover: fact("directory containing the --from Markdown file", "implementation_contract", "src/commands/wechat-draft.ts", "2026-09-01"),
            inlineTextAndStdinRelativeAssets: fact("invocation working directory", "implementation_contract", "src/commands/wechat-draft.ts", "2026-09-01"),
            coverFlagRelativeAssets: fact("invocation working directory", "implementation_contract", "src/commands/wechat-draft.ts", "2026-09-01"),
            absolutePathsAccepted: fact(true, "implementation_contract", "src/commands/wechat-draft.ts", "2026-09-01"),
          },
          permanentMaterialQuota: {
            imageAndNewsLimit: fact(100000, "official_documentation", WECHAT_QUOTA_DOC, "2026-08-31"),
            otherMaterialTypeLimit: fact(1000, "official_documentation", WECHAT_QUOTA_DOC, "2026-08-31"),
            includesWebConsoleMaterials: fact(true, "official_documentation", WECHAT_QUOTA_DOC, "2026-08-31"),
            eachFreshCoverUploadConsumesImageQuota: fact(true, "official_documentation", WECHAT_COVER_DOC, "2026-08-31"),
            identicalCoverDeduplication: unknown(ISSUE_42, "2026-08-31"),
          },
        },
        validation: {
          local: ["required fields", "shared cover/body extension policy", "file existence"],
          serverAuthoritative: ["all 字 measurement", "exact byte boundaries", "HTML effective maximum", "unknown media behavior"],
        },
        workflow: {
          objective: "Stage one Official Account news article in 草稿箱 through the WeChat API without publishing it.",
          owner: "cli_transport",
          preconditions: [
            "WECHAT_APP_ID and WECHAT_APP_SECRET are configured",
            "exactly one fixed egress setting is configured and its public IP is allowlisted",
            "the article resolves a title and an existing cover path",
          ],
          steps: [
            {
              id: "establish_readiness",
              actor: "agent",
              instruction: "Run publish wechat info or publish wechat check; follow readiness.nextStep until ready is true, including the human QR allowlist step for error 40164.",
              verification: "The API probe is authenticated; any token_refreshed healing is reported and the fixed egress is accepted.",
              evidenceRefs: ["readiness", "auth"],
            },
            {
              id: "prepare",
              actor: "agent",
              instruction: "Prepare Markdown, title/frontmatter, required cover, and local JPG/PNG body images; resolve Markdown/frontmatter-relative assets beside --from, resolve --cover from the invocation directory, and use external links only with the expected citation behavior or opt into --keep-links.",
              verification: "All required fields resolve, local files exist, and the cover/body extensions match the transport policy.",
              evidenceRefs: ["constraints.cover", "constraints.bodyImages", "constraints.pathResolution"],
            },
            {
              id: "preview",
              actor: "cli",
              instruction: "Run the advertised command with --dry-run and optionally --out <file.html>; deterministically render inline-styled HTML without network access.",
              verification: "The complete title/body/digest metadata and advisories are printed; no token, upload, or draft/add call occurs.",
              evidenceRefs: ["constraints.textFields", "constraints.htmlContent"],
            },
            {
              id: "stage",
              actor: "cli",
              instruction: "Run without --dry-run; upload the permanent cover, upload/rewrite local body images, then call draft/add with article_type=news.",
              verification: "The command exits 0 and returns media_id, thumb_media_id, body-image count when applicable, and the 草稿箱 URL.",
              evidenceRefs: ["readiness", "constraints.articleType", "constraints.cover.requiredPermanentMediaId", "constraints.bodyImages"],
            },
            {
              id: "inspect_draft",
              actor: "agent",
              instruction: "Open the 草稿箱 URL in the Official Account console and inspect title, inline styling, body images, citations/links, and both cover crop presentations.",
              verification: "The native draft preview contains the intended article after WeChat sanitization; unknown server transforms are recorded rather than assumed.",
              evidenceRefs: ["constraints.cover.supportedCropRatios", "constraints.htmlContent"],
            },
          ],
          successCriteria: ["draft/add returned a native draft media_id", "the 草稿箱 preview is visually checked", "no freepublish or mass-message endpoint was called"],
          terminalBoundary: "Stop in 草稿箱 after preview verification; publication remains a separate human action.",
          stopConditions: [
            { id: "auth_not_ready", when: "credentials, fixed egress, token exchange, or positive API proof is missing", actor: "agent", action: "Follow readiness.nextStep; do not upload material or call draft/add.", outcome: "needs_human" },
            { id: "ip_not_allowlisted", when: "WeChat returns 40164", actor: "human", action: "QR-authorize the fixed egress IP in 微信开发者平台, rerun publish wechat check, then retry from the start.", outcome: "needs_human" },
            { id: "local_validation_failed", when: "required title/cover, extension, file existence, or rendered content validation fails", actor: "agent", action: "Correct the supplied content/assets; do not start uploads.", outcome: "abort" },
            { id: "upload_or_server_rejected", when: "cover/body upload, quota, 字/HTML/media validation, or draft/add fails", actor: "agent", action: "Preserve the sanitized server receipt and unknowns; correct only the evidenced issue and do not claim a draft.", outcome: "abort" },
            { id: "preview_mismatch", when: "草稿箱 preview is missing or differs after sanitization/crop", actor: "agent", action: "Do not claim completion; surface the mismatch for correction or human review.", outcome: "needs_human" },
            { id: "draft_verified", when: "media_id exists and the 草稿箱 preview is accepted", actor: "agent", action: "Return the draft receipt and stop before any publication endpoint/control.", outcome: "success_terminal" },
          ],
        },
        gotchas: [
          "The official 32/16/120 字 limits do not define a local Unicode measurement; do not enforce them as code points.",
          "The three official HTML-size statements conflict, so no effective maximum is inferred.",
          "Cover uploads are permanent material; body uploadimg images do not consume the permanent-image quota.",
        ],
      },
    ],
    gotchas: [
      "All API calls require an allowlisted source IP; set exactly one of WECHAT_PROXY_URL or WECHAT_SSH_TUNNEL and use one fixed egress.",
      "The shared passive auth probe may renew the normal API token and reports token_refreshed in readiness.healed.",
    ],
    forbiddenActions: ["freepublish/*", "message/mass/*"],
  },

  xhs: {
    schemaVersion: CHANNEL_CAPABILITY_SCHEMA_VERSION,
    channel: "xhs",
    displayName: "Xiaohongshu / RedNote",
    executionMode: "agent_browser",
    supportBoundary: "Static info plus an agent-owned long-form browser boundary; publish-cli does not automate the website workflow.",
    responsibility: {
      cli: [
        "Return the offline execution contract and an agent-owned readiness descriptor; do not open, inspect, or mutate the website.",
      ],
      agent: [
        "Own the headful browser context, verify authentication, import the prepared artifact, review fidelity, optionally run layout/topics, save, reopen, and verify the browser-local draft.",
      ],
      human: [
        "Scan the QR code when required, review generated cards/cover and the reopened draft, preserve the browser profile, and make the final publication decision.",
      ],
      platform: [
        "Import and transform content, autosave browser-local state, generate optional layout cards/cover, resolve live topic entities, and enforce live limits.",
      ],
      rationale: [
        "The multistep creator workflow is best operated by a capable visual browser agent; publish-cli remains backend-agnostic and does not own selectors or session state.",
        "Long article is the initial format because it accepts canonical Markdown and matches the long-form essay workflow; image-text remains a separate deferred contract.",
      ],
    },
    excludedCapabilities: [
      {
        id: "cli_website_transport",
        disposition: "intentionally_excluded",
        reason: "publish-cli does not own Xiaohongshu selectors, login, composer execution, or browser state.",
        owner: "agent",
        alternative: "Follow the embedded long_article workflow in an agent-owned headful browser context.",
      },
      {
        id: "image_text_post",
        disposition: "deferred",
        reason: "Image-text staging semantics and field/count limits are not yet verified as a complete format contract.",
        owner: "agent",
        alternative: "Use the long-article workflow; treat the image-text upload facts as preparation guidance only.",
      },
      {
        id: "public_send",
        disposition: "intentionally_excluded",
        reason: "Final, private, and scheduled publication are outside the drafting contract.",
        owner: "human",
        alternative: "Review the reopened draft and use the platform's publication controls only with explicit authorization.",
      },
    ],
    auth: {
      mode: "agent-owned authenticated browser context",
      entryUrl: XHS_ENTRY_URL,
      workflowRef: XHS_CAPABILITY_WORKFLOW_REF,
      continueInSameContext: true,
    },
    state: {
      machineLocal: ["Agent-owned persistent browser profile; location is owned by the selected browser backend."],
      durable: [],
      recovery: [
        "QR-authenticate in the headful browser context that will continue the workflow; browser-local drafts disappear if that browser data is cleared.",
      ],
    },
    formats: [
      {
        id: "long_article",
        name: "Long-form article / 写长文",
        summary: "Import a prepared long article in an agent-owned browser, optionally turn it into image cards, then save and reopen the browser-local draft.",
        usage: "No CLI draft command. In a headful agent browser, open the capability entry URL, authenticate by QR if required, enter 写长文, import .md/.docx/.txt, review, optionally run 一键排版 and topics, then 暂存离开 and reopen from 草稿箱.",
        humanHighlights: [
          "Native import accepts .md, .docx, and .txt and overwrites the current body; the title is separate and the first Markdown H1 does not populate it.",
          "Observed editor limits are title 64 and body 10,000; exact Unicode measurement is unknown. H1/H2, lists, and quotes survived import; H3 downgraded and bold/italic were stripped.",
          "一键排版 is optional: the observed fixture generated 3 image cards, an auto-summary/template/cover, an auto-truncated final title, and a separate 1,000-character caption surface.",
          "Topics must be chosen through 话题 using exact live suggestions and verified as clickable entities; the maximum topic count is unknown.",
          "Drafts are browser-local, disappear if browser data is cleared, and have an observed maximum of 100; save with 暂存离开 and reopen before claiming success.",
          "Deferred image-text preparation guidance: multiple JPEG/PNG/WebP images, visible 32 MB maximum per image, no GIF/Live Photo; 3:4 through 2:1 and at least 720x960 are recommended, but complete staging limits are unknown.",
        ],
        action: "agent_browser_draft",
        platformSupported: true,
        transportSupport: "agent_operated",
        fields: [
          { name: "from", required: true, description: "Prepared .md, .docx, or .txt import artifact; import replaces the current editor body." },
          { name: "title", required: true, description: "Separate long-article title, observed visible maximum 64; never infer it from the imported H1." },
          { name: "oneClickLayout", required: false, description: "Run 一键排版 only when image-card output is requested; review template, cover, author, and summary before advancing." },
          { name: "topics", required: false, description: "Repeatable live topic queries for the post-layout composer; select exact suggestions, never paste plain hashtags as substitutes." },
          { name: "finalCaption", required: false, description: "Post-layout image-text caption, observed maximum 1,000; separate from the long-article body." },
        ],
        terminalState: "reopened browser-local draft after 暂存离开, preserving either the long article or the reviewed generated-card layout; not a cloud draft",
        constraints: {
          import: {
            acceptedExtensions: fact([".md", ".docx", ".txt"], "live_positive_fixture", ISSUE_35, "2026-08-30"),
            overwritesCurrentBody: fact(true, "live_positive_fixture", ISSUE_35, "2026-08-30"),
            firstH1PopulatesTitle: fact(false, "live_positive_fixture", ISSUE_35, "2026-08-30"),
            fidelity: {
              preserved: fact(["H1", "H2", "ordered list", "unordered list", "blockquote"], "live_positive_fixture", ISSUE_35, "2026-08-30"),
              downgraded: fact({ H3: "paragraph" }, "live_positive_fixture", ISSUE_35, "2026-08-30"),
              stripped: fact(["bold", "italic"], "live_positive_fixture", ISSUE_35, "2026-08-30"),
            },
          },
          editor: {
            titleVisibleMaximum: fact(64, "live_positive_fixture", ISSUE_35, "2026-08-30"),
            titleMeasurement: unknown(ISSUE_35, "2026-08-30"),
            bodyVisibleMaximum: fact(10000, "live_positive_fixture", ISSUE_35, "2026-08-30"),
            bodyMeasurement: unknown(ISSUE_35, "2026-08-30"),
            autosaveAdvertised: fact(true, "live_positive_fixture", ISSUE_35, "2026-08-30"),
          },
          oneClickLayout: {
            optional: true,
            observedGeneratedCardCount: fact(3, "live_positive_fixture", ISSUE_35, "2026-08-30"),
            generatedElements: fact(["image cards", "summary", "template", "cover"], "live_positive_fixture", ISSUE_35, "2026-08-30"),
            coverChoices: fact(["image", "no image"], "live_positive_fixture", ISSUE_35, "2026-08-30"),
            authorMaximum: fact(20, "live_positive_fixture", ISSUE_35, "2026-08-30"),
            summaryMaximum: fact(60, "live_positive_fixture", ISSUE_35, "2026-08-30"),
            wordCountAndReadDurationMinimumBodyLength: fact(1500, "live_positive_fixture", ISSUE_35, "2026-08-30"),
            nextStep: fact("generates images and opens the ordinary image-text composer", "live_positive_fixture", ISSUE_35, "2026-08-30"),
            finalTitleBehavior: fact("auto_truncated", "live_positive_fixture", ISSUE_35, "2026-08-30"),
            finalTitleMaximum: unknown(ISSUE_35, "2026-08-30"),
            finalTitleMeasurement: unknown(ISSUE_35, "2026-08-30"),
            finalCaptionVisibleMaximum: fact(1000, "live_positive_fixture", ISSUE_35, "2026-08-30"),
          },
          topics: {
            representation: fact("structured_clickable_entity", "live_positive_fixture", ISSUE_35, "2026-08-30"),
            resolution: fact("live_exact_match_suggestion", "live_positive_fixture", ISSUE_35, "2026-08-30"),
            observedPersistedCountAtLeast: fact(4, "live_positive_fixture", ISSUE_35, "2026-08-30"),
            actualMaximumCount: unknown(ISSUE_35, "2026-08-30"),
          },
          draft: {
            storage: fact("browser_local", "live_positive_fixture", ISSUE_35, "2026-08-30"),
            cloudSynced: fact(false, "live_positive_fixture", ISSUE_35, "2026-08-30"),
            lostWhenBrowserDataCleared: fact(true, "live_positive_fixture", ISSUE_35, "2026-08-30"),
            observedMaximumCount: fact(100, "live_positive_fixture", ISSUE_35, "2026-08-30"),
            saveAction: fact("暂存离开", "live_positive_fixture", ISSUE_35, "2026-08-30"),
            successSignal: fact("保存成功", "live_positive_fixture", ISSUE_35, "2026-08-30"),
            reopenPreserved: fact(["title", "three-card layout", "four selected topics"], "live_positive_fixture", ISSUE_35, "2026-08-30"),
          },
          deferredImageTextPreparation: {
            status: "not_a_complete_transport_contract",
            acceptedFormats: fact(["JPEG", "PNG", "WebP"], "live_positive_fixture", ISSUE_35, "2026-08-30"),
            rejectedFormats: fact(["GIF", "Live Photo"], "live_positive_fixture", ISSUE_35, "2026-08-30"),
            maximumBytesPerImageLabel: fact("32 MB", "live_positive_fixture", ISSUE_35, "2026-08-30"),
            exactMaximumBytes: unknown(ISSUE_35, "2026-08-30"),
            aspectRatioRestricted: fact(false, "live_positive_fixture", ISSUE_35, "2026-08-30"),
            recommendedAspectRatioRange: fact({ tallest: "3:4", widest: "2:1" }, "live_positive_fixture", ISSUE_35, "2026-08-30"),
            recommendedMinimumResolutionLabel: fact("at least 720x960", "live_positive_fixture", ISSUE_35, "2026-08-30"),
            imageCount: unknown(ISSUE_35, "2026-08-30"),
            titleBodyAndStagingSemantics: unknown(ISSUE_35, "2026-08-30"),
          },
        },
        validation: {
          local: ["prepared artifact extension", "required separate title", "caller-requested optional branch inputs"],
          liveAgent: ["authenticated creator UI", "import fidelity", "visible counters", "generated layout", "exact topic entities", "save and reopen persistence"],
          serverAuthoritative: ["Unicode measurement", "topic maximum", "all deferred image-text maxima and staging semantics"],
        },
        workflow: {
          objective: "Import a prepared long article, optionally create a reviewed image-card post, and leave a verified browser-local draft without publishing.",
          owner: "agent_browser",
          preconditions: [
            "a headful browser/computer-use backend with a persistent local profile is selected",
            "the prepared .md/.docx/.txt artifact and separate title are available",
            "a human can scan the QR code if the live creator UI is logged out",
          ],
          steps: [
            {
              id: "authenticate",
              actor: "agent",
              instruction: "Open the capability entry URL; if logged out, show the QR code to the human; positively identify the authenticated creator UI and keep this same browser context.",
              verification: "The creator landing/composer controls are visible in the authenticated context; a stale profile or merely loaded login page is not readiness proof.",
              evidenceRefs: ["readiness", "auth"],
            },
            {
              id: "import",
              actor: "agent",
              instruction: "Enter 写长文, start 新的创作, invoke file import, acknowledge that import replaces the body, and upload the prepared .md/.docx/.txt artifact.",
              verification: "The imported body is present and complete; H1/H2/lists/quotes and known H3/bold/italic downgrades are visibly reviewed.",
              evidenceRefs: ["constraints.import.acceptedExtensions", "constraints.import.overwritesCurrentBody", "constraints.import.fidelity"],
            },
            {
              id: "set_title",
              actor: "agent",
              instruction: "Populate the separate title field explicitly; do not expect the first imported H1 to fill it; keep title/body within the visible 64/10,000 counters.",
              verification: "The intended title is visible in the title field and no over-limit state is shown.",
              evidenceRefs: ["constraints.import.firstH1PopulatesTitle", "constraints.editor.titleVisibleMaximum", "constraints.editor.bodyVisibleMaximum"],
            },
            {
              id: "choose_output_branch",
              actor: "agent",
              instruction: "If a plain long-article draft is requested, skip 一键排版. If an image-card post is requested, run 一键排版, inspect every generated card, choose template/cover, review optional author (20) and summary (60), then advance to generate images.",
              verification: "The chosen branch matches the task; generated cards/cover/summary are visibly approved before advancing, and unexpected auto-truncation is corrected or reported.",
              evidenceRefs: ["constraints.oneClickLayout"],
            },
            {
              id: "complete_post_layout",
              actor: "agent",
              instruction: "On the image-card branch, review the generated images and final title, fill the separate caption within 1,000 when needed, and add each requested topic through 话题 by selecting an exact live suggestion.",
              verification: "Every requested topic is a clickable platform entity, not plain hashtag text; image order, title, and caption are visibly correct.",
              evidenceRefs: ["constraints.oneClickLayout.finalCaptionVisibleMaximum", "constraints.topics"],
            },
            {
              id: "save",
              actor: "agent",
              instruction: "Choose 暂存离开 and wait for 保存成功; do not use final, private, or scheduled publication controls.",
              verification: "保存成功 is visible and the workflow returns to a state from which 草稿箱 can be opened.",
              evidenceRefs: ["constraints.draft.saveAction", "constraints.draft.successSignal"],
            },
            {
              id: "reopen",
              actor: "agent",
              instruction: "Open 草稿箱 in the same persistent profile, reopen the saved item, and compare title/body or generated cards/caption/topics with the intended result.",
              verification: "The expected title and selected branch content persist after reopen; report the browser-local storage risk and preserve the profile.",
              evidenceRefs: ["constraints.draft.storage", "constraints.draft.lostWhenBrowserDataCleared", "constraints.draft.reopenPreserved"],
            },
          ],
          successCriteria: [
            "the prepared article was imported and visibly reviewed",
            "the requested plain-article or generated-card branch persists after 草稿箱 reopen",
            "requested topics persist as clickable entities",
            "no public/private/scheduled publication occurred",
          ],
          terminalBoundary: "Stop on the reopened browser-local draft; preserve the browser profile and do not operate any publication control.",
          stopConditions: [
            { id: "auth_not_proven", when: "the authenticated creator UI is not positively identified", actor: "agent", action: "Pause for QR login/challenge or report the browser state as inconclusive; do not infer readiness.", outcome: "needs_human" },
            { id: "import_or_limit_failed", when: "the artifact is rejected, body is incomplete, or a title/body counter is over limit", actor: "agent", action: "Correct the prepared artifact/title; do not continue to layout or save.", outcome: "abort" },
            { id: "layout_not_approved", when: "generated cards, cover, summary, title truncation, image order, or caption differs from the requested output", actor: "agent", action: "Stay in the editor for correction/review; do not silently accept the transform.", outcome: "needs_human" },
            { id: "topic_not_resolved", when: "a requested topic is not an exact clickable live entity", actor: "agent", action: "Leave it unresolved or ask for a different live choice; never substitute plain hashtag text silently.", outcome: "needs_human" },
            { id: "save_or_reopen_failed", when: "保存成功 is absent or reopened content does not match", actor: "agent", action: "Do not claim a durable draft; keep the context for inspection and report browser-local risk.", outcome: "abort" },
            { id: "draft_verified", when: "the requested branch and topics persist after 草稿箱 reopen", actor: "agent", action: "Return the browser-local draft result, preserve the profile, and stop before publication.", outcome: "success_terminal" },
          ],
        },
        gotchas: [
          "Continue authentication and drafting in the same agent-owned browser context.",
          "Browser-local drafts disappear when browser data is cleared; saving and reopening in a disposable context is not durable delivery.",
          "一键排版 changes the artifact into generated image cards and a separate composer; it is never a silent default.",
        ],
      },
    ],
    gotchas: ["Selector details remain live/browser-agent-owned, but this info contract contains the complete semantic workflow and verification boundary."],
    forbiddenActions: ["final publish", "private publish", "scheduled publish"],
  },

  "1point3acres": {
    schemaVersion: CHANNEL_CAPABILITY_SCHEMA_VERSION,
    channel: "1point3acres",
    displayName: "1point3acres",
    executionMode: "human_handoff",
    supportBoundary: "Static offline info and a human-operated textual handoff only; no website automation or crawling.",
    responsibility: {
      cli: [
        "Return the offline destination/composer contract and readiness handoff without accessing the website.",
      ],
      agent: [
        "Choose a curated destination or prepare a custom-target question, validate the known title/examples and required metadata, and assemble the exact title/body handoff.",
      ],
      human: [
        "Use a normal authorized browser to authenticate, confirm live destination rules, fill the composer, save/reopen the native draft, and retain the final submit decision.",
      ],
      platform: [
        "Enforce current forum/category/metadata rules, apply the weighted title counter and unknown body limits, and persist the native website draft.",
      ],
      rationale: [
        "The site terms do not authorize a general automated browser transport; the safe product boundary is offline guidance plus a textual human handoff.",
        "A small curated destination map avoids runtime crawling while a custom target remains possible through human inspection.",
      ],
    },
    excludedCapabilities: [
      {
        id: "automated_website_transport",
        disposition: "intentionally_excluded",
        reason: "The authorized boundary does not include automated login, CAPTCHA handling, composer filling, draft saving, or submission.",
        owner: "human",
        alternative: "Use the embedded handoff workflow in a normal human-operated browser.",
      },
      {
        id: "runtime_forum_crawl",
        disposition: "intentionally_excluded",
        reason: "Destination discovery is bounded to a checked-in curated map; the CLI does not crawl the forum.",
        owner: "human",
        alternative: "Inspect an uncommon target manually and supply the resulting URL, forum id, and required metadata to the handoff.",
      },
      {
        id: "public_send",
        disposition: "intentionally_excluded",
        reason: "Publication is irreversible enough to require an explicit human decision; authored posts have limited edit/delete recovery.",
        owner: "human",
        alternative: "Save and reopen the native draft; use 发布帖子 only after explicit approval.",
      },
    ],
    auth: {
      mode: "human-owned normal-browser authentication and content execution; publish-cli remains an offline handoff",
      entryUrl: ONEPOINT3ACRES_ENTRY_URL,
      workflowRef: ONEPOINT3ACRES_CAPABILITY_WORKFLOW_REF,
      continueInSameContext: true,
    },
    state: {
      machineLocal: [],
      durable: [],
      recovery: [
        "No publish-cli browser/profile state is created; prepare text locally and hand it to the human-operated authorized browser workflow.",
      ],
    },
    formats: [
      {
        id: "text_thread",
        name: "Text thread",
        summary: "Prepare an offline textual handoff for a human to save in a normal authorized browser; publish-cli never accesses the website.",
        usage: "No CLI draft command. Select workplace-reflection, chinese-life, job-search, or a manually inspected custom target; hand the exact URL/category/title/Markdown body/required metadata to a human; the human uses 保存草稿 and reopens 草稿箱.",
        humanHighlights: [
          "Curated targets: 职场达人/职场感言 (fid 98, default), 华人生活 (fid 29), and 求职（非面经） (fid 28); uncommon targets require manual inspection, not CLI crawling.",
          "The title counter is weighted with a visible maximum 40: 40 ASCII→20, 41 ASCII→21, 40 CJK→40, 41 CJK→41, and 40 😀→80; the exact algorithm is unknown.",
          "The composer says Markdown is supported; body maximum is unknown. The initial handoff is textual and excludes images, video, attachments, polls, topics, aliases, anonymous posting, props, and site AI.",
          "求职（非面经） requires a theme plus 找工年度, 工作职位类别, 专业, and 相关工作经验范围; 地区 is optional and live choices are time-sensitive.",
          "保存草稿 is live-verified: title, body, forum category, timestamp, and draft count persisted after reopening 草稿箱.",
          "Public submission is human-only; the current terms boundary forbids treating a headful browser as authorization for an automated transport.",
        ],
        action: "human_handoff",
        platformSupported: true,
        transportSupport: "manual_handoff_only",
        fields: [
          { name: "target", required: true, description: "One curated slug or a custom URL/forum id obtained through manual authorized inspection." },
          { name: "title", required: true, description: "Thread title checked against the visible weighted 40-unit examples; exact local weighting is unknown." },
          { name: "body", required: true, description: "Prepared textual Markdown body; maximum size remains a live/server unknown." },
          { name: "theme", required: false, description: "Required for 职场达人 and 求职（非面经）; use the exact visible label in the human handoff." },
          { name: "jobSearchMetadata", required: false, description: "Required for 求职（非面经）: year, job category, major, and experience range; region optional." },
        ],
        terminalState: "native website draft saved with 保存草稿 and reopened from 草稿箱 by a human; publish-cli itself ends at the local textual handoff",
        constraints: {
          authorizationBoundary: {
            termsUrl: fact(ONEPOINT3ACRES_TERMS, "official_documentation", ONEPOINT3ACRES_TERMS, "2026-09-01"),
            nonAuthorizedAutomatedAccessProhibited: fact(true, "official_documentation", ONEPOINT3ACRES_TERMS, "2026-09-01"),
            productHasSeparateAutomationAuthorization: false,
            cliRuntimeWebsiteAccess: false,
            humanNormalBrowserRequired: true,
          },
          curatedDestinations: {
            workplaceReflection: {
              slug: "workplace-reflection",
              forum: "职场达人",
              forumId: 98,
              composerUrl: "https://www.1point3acres.com/editor/thread?fid=98&from=home",
              themeRequired: true,
              defaultTheme: "职场感言",
              use: "workplace and career reflections",
              observedThemes: fact(
                ["职场感言", "请问贵司", "管理", "晋升", "老板相处", "辞职", "扩张", "绩效", "换组", "跳槽", "改行", "自我提升", "裁员", "新组上路", "同事协作", "带新人", "实习体验", "求比较"],
                "live_positive_fixture",
                ISSUE_36,
                "2026-08-30",
              ),
            },
            chineseLife: {
              slug: "chinese-life",
              forum: "海外生活 / 华人生活",
              forumId: 29,
              composerUrl: "https://www.1point3acres.com/editor/thread?fid=29&from=home",
              themeRequired: false,
              use: "overseas Chinese life and community experience",
            },
            jobSearch: {
              slug: "job-search",
              forum: "海外求职 / 求职（非面经）",
              forumId: 28,
              composerUrl: "https://www.1point3acres.com/editor/thread?fid=28&from=home",
              themeRequired: true,
              use: "job-search writing that is not interview-experience content",
              observedThemes: fact(["其他", "求职简历", "找工就业", "实习", "选组选Offer", "应届生NG", "ICC合同工", "EE硬件", "TeamMatch"], "live_positive_fixture", ISSUE_36, "2026-08-30"),
              requiredMetadata: {
                jobYear: fact("visible choices 2011-2029; order and freshness are time-sensitive", "live_positive_fixture", ISSUE_36, "2026-08-30"),
                jobCategory: fact(["management", "general software", "statistics", "data science/analysis", "quant finance", "hardware/electronics", "engineering", "PM", "design", "mobile", "frontend", "ML engineering", "data engineering", "other"], "live_positive_fixture", ISSUE_36, "2026-08-30"),
                major: fact("enumerated taxonomy including CS, EE, statistics, finance, data science, and Other", "live_positive_fixture", ISSUE_36, "2026-08-30"),
                experienceRange: fact(["fresh grad", "≤3 months", "3 months-1 year", "1-3 years", "3-5 years", "5-10 years", "11-15 years", ">15 years"], "live_positive_fixture", ISSUE_36, "2026-08-30"),
                regionRequired: fact(false, "live_positive_fixture", ISSUE_36, "2026-08-30"),
              },
            },
            customTarget: {
              runtimeCrawledByCli: false,
              requiredHandoffFacts: ["forum id or composer URL", "visible category/theme", "required metadata", "current destination rules"],
            },
          },
          composer: {
            title: {
              visibleMaximumWeightedUnits: fact(40, "live_positive_fixture", ISSUE_36, "2026-08-30"),
              domMaxlength: fact(80, "live_positive_fixture", ISSUE_36, "2026-08-30"),
              measurement: unknown(ISSUE_36, "2026-08-30"),
              observedExamples: fact(
                [
                  { input: "40 ASCII letters", displayed: "20 / 40" },
                  { input: "41 ASCII letters", displayed: "21 / 40" },
                  { input: "40 CJK characters", displayed: "40 / 40" },
                  { input: "41 CJK characters", displayed: "41 / 40" },
                  { input: "40 grinning-face emoji", displayed: "80 / 40" },
                ],
                "live_positive_fixture",
                ISSUE_36,
                "2026-08-30",
              ),
            },
            body: {
              markdownSupported: fact(true, "live_positive_fixture", ISSUE_36, "2026-08-30"),
              maximum: unknown(ISSUE_36, "2026-08-30"),
            },
            initialTransport: {
              textOnly: true,
              excludedFeatures: ["images", "video", "attachments", "polls", "aliases", "anonymous posting", "topics", "props", "site AI assistant"],
            },
            draft: {
              saveAction: fact("保存草稿", "live_positive_fixture", ISSUE_36, "2026-08-30"),
              reopenLocation: fact("草稿箱", "live_positive_fixture", ISSUE_36, "2026-08-30"),
              persisted: fact(["title", "body", "forum category", "save timestamp", "draft count"], "live_positive_fixture", ISSUE_36, "2026-08-30"),
            },
          },
          routingGotchas: {
            evidenceStatus: fact("rules visible for the three curated destinations during the bounded composer inspection", "live_positive_fixture", ISSUE_36, "2026-08-30"),
            workplaceReflection: ["job-search experience/questions belong in forum 28", "interview experience belongs in forum 145", "PIP/support/Dev List topics have separate forums"],
            chineseLife: ["use specialized boards when applicable", "referrals and rental ads are forbidden in this forum"],
            jobSearch: ["no reply-gated or email-for-material posts", "interview, referral, salary, technical, and OPT/H1B topics belong in dedicated forums"],
          },
        },
        validation: {
          local: ["curated target completeness", "required title/body", "known destination-specific metadata", "weighted title fixture comparisons"],
          humanLive: ["authentication", "current destination rules", "visible category choices", "weighted counter state", "draft save and reopen"],
          serverAuthoritative: ["exact title weighting", "body maximum", "novel composer validation", "custom target rules"],
        },
        workflow: {
          objective: "Give a human a complete textual handoff that they can save and reopen as a native 1point3acres draft without automated website access or public submission.",
          owner: "human_handoff",
          preconditions: [
            "the agent has the intended title/body and audience context",
            "a human has an authorized normal browser and can authenticate",
            "custom targets, if any, are inspected by the human rather than crawled by publish-cli",
          ],
          steps: [
            {
              id: "select_target",
              actor: "agent",
              instruction: "Choose the curated destination by use case: workplace-reflection/fid 98 (default career reflection), chinese-life/fid 29, or job-search/fid 28; otherwise ask the human for a manually inspected custom composer URL and rules.",
              verification: "The handoff names the exact composer URL, forum id/name, use case, and any routing gotcha that was checked.",
              evidenceRefs: ["constraints.curatedDestinations", "constraints.routingGotchas"],
            },
            {
              id: "prepare_handoff",
              actor: "agent",
              instruction: "Assemble exact title and Markdown body; include the visible theme for fid 98/28 and all four required job-search metadata fields for fid 28; compare the title with the known weighted-counter fixtures without inventing the missing algorithm.",
              verification: "The handoff is copy-ready and contains no unresolved required field; unknown body/title rules are explicitly marked for live confirmation.",
              evidenceRefs: ["constraints.curatedDestinations.jobSearch.requiredMetadata", "constraints.composer.title", "constraints.composer.body"],
            },
            {
              id: "authenticate_and_confirm",
              actor: "human",
              instruction: "Open the exact composer URL in a normal browser, authenticate/solve any challenge, and confirm the live forum/category/rules before entering content.",
              verification: "The intended forum composer and required selectors are visibly present; any changed rule is resolved before content entry.",
              evidenceRefs: ["readiness", "auth", "constraints.authorizationBoundary"],
            },
            {
              id: "fill_composer",
              actor: "human",
              instruction: "Select the exact theme and required structured metadata, paste the prepared title/body, and inspect the weighted title counter and rendered Markdown preview.",
              verification: "The counter is not over 40, the preview contains the complete body, and every required field is visibly selected.",
              evidenceRefs: ["constraints.composer.title", "constraints.composer.body", "constraints.curatedDestinations.jobSearch.requiredMetadata"],
            },
            {
              id: "save_draft",
              actor: "human",
              instruction: "Choose 保存草稿, open 草稿箱, and reopen the saved thread; do not use 发布帖子.",
              verification: "Title, body, forum category/metadata, and saved-draft state persist after reopen.",
              evidenceRefs: ["constraints.composer.draft"],
            },
            {
              id: "report",
              actor: "agent",
              instruction: "Record that the human verified a native draft, retain any changed live constraint, and state published=false.",
              verification: "The result distinguishes the CLI's local handoff from the human's native-draft verification and makes no automation claim.",
              evidenceRefs: ["constraints.authorizationBoundary", "constraints.composer.draft"],
            },
          ],
          successCriteria: ["the handoff contains every target-specific required value", "the human saved and reopened the exact native draft", "published is false"],
          terminalBoundary: "Stop at the reopened native draft; 发布帖子 is never part of this workflow.",
          stopConditions: [
            { id: "target_contract_incomplete", when: "the curated target does not fit or a custom target lacks manually confirmed URL/rules/metadata", actor: "agent", action: "Ask the human to inspect and supply the missing target contract; do not crawl the site.", outcome: "needs_human" },
            { id: "title_or_metadata_invalid", when: "the visible weighted title counter exceeds 40 or a required theme/job-search field is missing", actor: "human", action: "Correct the handoff/live field values before saving.", outcome: "needs_human" },
            { id: "auth_or_rule_changed", when: "login/challenge is incomplete or the live destination rules differ", actor: "human", action: "Resolve authentication and update the handoff; do not bypass the changed rule.", outcome: "needs_human" },
            { id: "save_or_reopen_failed", when: "保存草稿 is unavailable or reopened title/body/category/metadata differs", actor: "human", action: "Do not claim a native draft; correct and repeat the manual save/reopen check.", outcome: "abort" },
            { id: "draft_verified", when: "the human confirms the exact reopened native draft", actor: "agent", action: "Record published=false and stop before 发布帖子.", outcome: "success_terminal" },
          ],
        },
        gotchas: [
          "Do not crawl, automate login, fill a composer, solve CAPTCHA, save, or submit through publish-cli or a general browser transport.",
          "A loaded headful browser is not authorization for automation; the human performs all website operations.",
        ],
      },
    ],
    gotchas: ["The curated map is intentionally small and offline; custom targets require a human-confirmed live contract."],
    forbiddenActions: ["website crawling", "automated login", "automated composer filling", "Post"],
  },
};

export const CHANNEL_CAPABILITIES: Readonly<Record<AuthPlatform, ChannelStaticCapabilities>> = registry;

export function getChannelCapabilities(channel: AuthPlatform): ChannelStaticCapabilities {
  return CHANNEL_CAPABILITIES[channel];
}
