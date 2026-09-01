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

const unknown = (source: string, lastVerified: string) =>
  fact(null, "unknown", source, lastVerified);

const registry: Record<AuthPlatform, ChannelStaticCapabilities> = {
  x: {
    schemaVersion: CHANNEL_CAPABILITY_SCHEMA_VERSION,
    channel: "x",
    displayName: "X",
    executionMode: "cli_transport",
    supportBoundary: "Stages native Unsent post/thread drafts and autosaved Article drafts; never posts or publishes.",
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
        usage: "publish x draft --format tweet (--text <content> | --from <base.md|->) [--long]",
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
        gotchas: [
          "The official web-draft statement conflicts with live Premium fixtures; 25,000 is a platform maximum, not a proven draftable maximum.",
        ],
      },
      {
        id: "thread",
        name: "Thread",
        summary: "Numbered plain-text sequence; every row independently uses X's weighted 280 limit.",
        usage: "publish x draft --format thread (--text <content> | --from <base.md|->)",
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
        gotchas: ["Verification currently matches the first staged row, not every row after reopen."],
      },
      {
        id: "article",
        name: "Article",
        summary: "Premium rich Article with optional auto-discovery of an already-prepared cover; autosaves as an Article draft.",
        usage: "publish x draft --format article --from <base.md>",
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
        usage: "publish linkedin draft (--text <content> | --from <base.md|->) [--media <path> ...]",
        humanHighlights: [
          "Text is capped at 3,000 UTF-16 code units.",
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
        usage: "publish reddit draft --subreddit <name> --title <title> (--text <body> | --from <base.md|->) [--flair <id|text>] [--nsfw] [--spoiler]",
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
        usage: "publish wechat draft (--from <base.md|-> | --text <content>) [--title <title>] [--author <name>] [--digest <summary>] [--cover <image>] [--source-url <url>] [--keep-links]",
        humanHighlights: [
          "Cover formats: BMP/PNG/JPEG/JPG/GIF with documented label 10M; body images: JPG/PNG with documented wording 1MB以下. Exact byte boundaries are unknown/server-authoritative.",
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
        summary: "Agent-browser long-form workflow with a browser-local draft; it is not cloud-synced and is lost if browser data is cleared. The CLI transport and detailed execution contract are not implemented in #32.",
        usage: "No CLI execution command in issue #32; use the agent-owned workflowRef and issue #35 contract.",
        humanHighlights: [
          "The only initial format is a long article ending in a reopened browser-local draft, not a cloud draft.",
          "Detailed limits/import behavior remain unresolved in this issue and are server/workflow-authoritative under issue #35.",
        ],
        action: "agent_browser_draft",
        platformSupported: true,
        transportSupport: "agent_operated",
        fields: [
          { name: "from", required: true, description: "Prepared long-form import artifact; detailed accepted formats remain owned by issue #35." },
          { name: "title", required: true, description: "Long-article title populated and verified in the live workflow." },
        ],
        terminalState: "reopened browser-local long-article draft after temporary save; not a cloud draft; final publication remains forbidden",
        constraints: {
          detailedContractOwner: "issue #35",
          detailedConstraints: unknown(ISSUE_35, "2026-08-31"),
        },
        validation: {
          local: [],
          serverAuthoritative: ["all detailed format constraints until issue #35 lands"],
        },
        gotchas: [
          "Continue authentication and drafting in the same agent-owned browser context.",
          "Browser-local drafts disappear when browser data is cleared; issue #35 owns persistence verification and the detailed save contract.",
        ],
      },
    ],
    gotchas: ["Detailed selectors, limits, and workflow steps are intentionally downstream to issue #35."],
    forbiddenActions: ["final publish", "private publish", "scheduled publish"],
  },

  "1point3acres": {
    schemaVersion: CHANNEL_CAPABILITY_SCHEMA_VERSION,
    channel: "1point3acres",
    displayName: "1point3acres",
    executionMode: "human_handoff",
    supportBoundary: "Static offline info and a human-operated textual handoff only; no website automation or crawling.",
    auth: {
      mode: "agent-owned browser recovery; content execution remains a human handoff outside publish-cli",
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
        summary: "Offline/manual textual handoff; publish-cli does not inspect, fill, save, or submit the website composer.",
        usage: "No CLI execution command in issue #32; prepare target/title/body locally for human handoff.",
        humanHighlights: [
          "Only a local textual handoff is supported; publish-cli performs no crawl, login, composer fill, save, or submit.",
          "Destination and composer constraints remain unresolved until issue #37 provides the authorized handoff contract.",
        ],
        action: "human_handoff",
        platformSupported: true,
        transportSupport: "manual_handoff_only",
        fields: [
          { name: "target", required: true, description: "Human-selected forum target; curated mappings remain owned by issue #37." },
          { name: "title", required: true, description: "Thread title for manual entry." },
          { name: "body", required: true, description: "Prepared textual body for manual entry." },
        ],
        terminalState: "local handoff to a human-operated normal browser",
        constraints: {
          detailedContractOwner: "issue #37",
          detailedConstraints: unknown(ISSUE_37, "2026-08-31"),
        },
        validation: {
          local: [],
          serverAuthoritative: ["all destination and composer constraints until issue #37 lands"],
        },
        gotchas: ["Do not crawl, automate login, fill a composer, solve CAPTCHA, save, or submit."],
      },
    ],
    gotchas: ["Detailed forum mappings and handoff procedures are intentionally downstream to issue #37."],
    forbiddenActions: ["website crawling", "automated login", "automated composer filling", "Post"],
  },
};

export const CHANNEL_CAPABILITIES: Readonly<Record<AuthPlatform, ChannelStaticCapabilities>> = registry;

export function getChannelCapabilities(channel: AuthPlatform): ChannelStaticCapabilities {
  return CHANNEL_CAPABILITIES[channel];
}
