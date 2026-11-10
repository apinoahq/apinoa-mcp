# Changelog

## 0.2.12

Code mode's types and the bundled catalog follow the API as of 2026-11-10.

## 0.2.11

Code mode's types and the bundled catalog follow the API as of 2026-11-10:

- `Group`: new `audio`.

## 0.2.10

- New tool `read_image_text`: reads the text in an image from its URL (OCR) and returns every region with its
  text, confidence and position. It calls the new OCR API, `POST /v1/ocr`: one credit per image, a very long image
  one credit per section it is read in. Served in both modes, like `translate_image`.

## 0.2.9

Code mode's types and the bundled catalog follow the API as of 2026-11-08:

- New operations: `GET /v1/company/technologies`, `POST /v1/copilot/answer`, `GET /v1/facebook/profile`, `GET /v1/facebook/ads`.
- New type `CompanyPage`.
- New type `Dns`.
- New type `Evidence`.
- New type `FacebookAd`.
- New type `FacebookAdCard`.
- New type `FacebookAdDisclaimer`.
- New type `FacebookAdImage`.
- New type `FacebookAdPage`.
- New type `FacebookAdVideo`.
- New type `FacebookAdsPage`.
- New type `FacebookAdsPageResponse`.
- New type `FacebookRange`.
- New type `Redirect`.
- New type `Robots`.
- New type `TechnologiesResult`.
- New type `TechnologiesResultResponse`.
- New type `Technology`.

## 0.2.8

- New: `npx apinoa-mcp login` gets an API key from the terminal. It prints an apinoa address and a code, opens the page in your browser, and once you sign in, enter the code and approve, saves the key to `.env` in the current folder as `APINOA_API_KEY` (`--out <path>` for another file, `--no-browser` to only print the address). An existing `APINOA_API_KEY` line is replaced and the rest of the file is kept; a new file is readable by you only. It warns when the file is not ignored by git or other users can read it, and it never prints the full key.
- A key made this way expires after 90 days. The CLI keeps up to five keys per account, and `login` says when a sign-in revoked the oldest.
- An account's first key made this way can come with $0.10 of evaluation credit; `login` says so when it does.
- `APINOA_API_URL` sets where `login` signs in (https only; http for localhost).
- The server itself is unchanged; without `login` the command starts it as before.
- The official MCP Registry entry lists the hosted server, `https://api.apinoa.com/mcp`, under `remotes`.

## 0.2.7

The bundled catalog, which the server falls back on when it cannot read the live one, follows `GET /v1/marketplaces` as of 2026-11-04:

- Walmart `product` takes `seller`, a seller's numeric id, to get that seller's offer.
- Entries no longer carry `parserVersion`, which the live catalog no longer publishes.

## 0.2.6

- Listed in the official MCP Registry as `io.github.apinoahq/apinoa-mcp`: `package.json` names the server (`mcpName`), and `server.json` describes it, its npm package and its `APINOA_API_KEY` and `APINOA_MCP_MODE` settings. Each release is published there after npm.

## 0.2.5

- The server's instructions now name every source it serves, built from the catalog: marketplace products, social posts, search results from 16 search engines and answers from six AI answer engines. Tools mode sends instructions too; before, only code mode did.
- `call_apinoa` says it reaches search results and AI answers.
- The README adds Codex setup (`codex mcp add`) and examples for search rankings and AI answers.

## 0.2.4

Code mode's types and the bundled catalog follow the API as of 2026-10-30:

- `google-shopping` `reviews`: `id` now says which products have reviews: only a product Google groups across stores, whose id is digits only. Another id answers `404 REVIEWS_NOT_FOUND`, with a message naming it.

## 0.2.3

Code mode's types and the bundled catalog follow the API as of 2026-10-30:

- New operations: `GET /v1/app-store/search`, `GET /v1/app-store/app`, `GET /v1/app-store/reviews`, `GET /v1/baidu/search`, `GET /v1/baidu/suggestions`, `GET /v1/bing/search`, `GET /v1/bing/suggestions`, `POST /v1/chatgpt/answer`, `GET /v1/daum/search`, `GET /v1/daum/suggestions`, `GET /v1/duckduckgo/search`, `GET /v1/duckduckgo/suggestions`, `POST /v1/gemini/answer`, `GET /v1/google/search`, `GET /v1/google/suggestions`, `GET /v1/google/places`, `GET /v1/google/place`, `POST /v1/google-ai-mode/answer`, `POST /v1/google-aio/answer`, `GET /v1/google-play/search`, `GET /v1/google-play/app`, `GET /v1/google-play/reviews`, `GET /v1/google-shopping/search`, `GET /v1/google-shopping/product`, `GET /v1/google-shopping/reviews`, `GET /v1/google-trends/explore`, `GET /v1/google-trends/trending`, `GET /v1/naver/search`, `GET /v1/naver/suggestions`, `GET /v1/naver/places`, `GET /v1/naver/place`, `GET /v1/naver/reviews`, `POST /v1/naver-ai-brief/answer`, `POST /v1/naver-ai-tab/answer`, `GET /v1/seznam/search`, `GET /v1/seznam/suggestions`, `GET /v1/sogou/search`, `GET /v1/sogou/suggestions`, `GET /v1/tripadvisor/places`, `GET /v1/tripadvisor/place`, `GET /v1/tripadvisor/reviews`, `GET /v1/yahoo/search`, `GET /v1/yahoo/suggestions`, `GET /v1/yahoo-japan/search`, `GET /v1/yahoo-japan/suggestions`, `GET /v1/yandex/search`, `GET /v1/yandex/suggestions`, `GET /v1/yandex/places`, `GET /v1/yandex/place`, `GET /v1/yandex/reviews`.
- New type `Address`.
- New type `Answer`.
- New type `AnswerMention`.
- New type `AnswerResponse`.
- New type `App`.
- New type `AppResponse`.
- New type `AppReview`.
- New type `AppReviewsPage`.
- New type `AppReviewsPageResponse`.
- New type `AppsPage`.
- New type `AppsPageResponse`.
- New type `Block`.
- New type `Card`.
- New type `Citation`.
- New type `Conversation`.
- New type `Developer`.
- New type `Hours`.
- New type `PlaceReview`.
- New type `PlaceReviewsPage`.
- New type `PlaceReviewsPageResponse`.
- New type `PlacesPage`.
- New type `PlacesPageResponse`.
- New type `Price`.
- New type `Related`.
- New type `RelatedItem`.
- New type `Result`.
- New type `ResultsPage`.
- New type `ResultsPageResponse`.
- New type `SerpItem`.
- New type `SerpLink`.
- New type `SerpPlace`.
- New type `SerpPlaceResponse`.
- New type `Source`.
- New type `Suggestion`.
- New type `Suggestions`.
- New type `SuggestionsResponse`.
- New type `TrendPoint`.
- New type `TrendRegion`.
- New type `TrendingItem`.
- New type `TrendingPage`.
- New type `TrendingPageResponse`.
- New type `TrendsExplore`.
- New type `TrendsExploreResponse`.

## 0.2.2

- The server reports its package version to the client (0.2.1 still said 0.2.0).

Code mode's types and the bundled catalog follow the API as of 2026-10-29:

- New type `CaptionTrack`.
- New type `MediaTag`.
- New type `ProtectionPlan`.
- `Account`: new `location`.
- `AccountPage`: no longer `total`.
- `AccountRef`: new `bio`, `bannerUrl`, `createdAt`, `links`, `private`, `category`, `location`.
- `Audio`: new `coverUrl`, `durationSec`, `original`, `album`, `ext`.
- `Broadcast`: new `ext`; no longer `scheduledAt`, `startedAt`, `endedAt`.
- `CategoryList`: new `ext`.
- `CategoryNode`: new `imageUrl`; no longer `productCount`.
- `Comment`: new `entities`, `edited`; no longer `moreReplies.ids`.
- `CommentPage`: new `order`, `post`.
- `DeliveryOption`: new `ext`; no longer `guaranteedDays`, `membership`, `tracking`.
- `FacetValue`: no longer `count`.
- `GroupPage`: new `order`; no longer `total`.
- `Job`: new `applyMethod`.
- `JobPage`: new `items.insights`.
- `LinkPreview`: new `ext`.
- `MediaVariant`: new `codec`, `sizeBytes`, `fps`, `quality`, `ext`.
- `MediaVideo`: new `ext`; no longer `creator`.
- `Mention`: new `ext`.
- `Offer`: new `shippingOptions`, `unitPrice`, `promotions`, `paymentOptions`.
- `Place`: new `type`, `ext`; no longer `region`, `postalCode`.
- `Poll`: new `ext`.
- `Post`: new `edited`; no longer `metrics.liveViewers`.
- `PostPage`: new `order`.
- `Product`: new `offersSummary.ext`, `highlights`, `protectionPlans`, `package.ext`; no longer `offersSummary.url`, `package.lengthCm`, `package.widthCm`, `package.heightCm`, `package.soldInLot`, `wholesale`, `included`.
- `Rating`: new `starCounts`.
- `Review`: new `authorAvatarUrl`, `unhelpfulCount`, `recommended`, `badges`, `syndicatedFrom`, `productId`, `productImageUrl`, `variantId`, `language`.
- `ReviewPage`: new `reviewSummary`, `reviewAspects`.
- `SearchItem`: new `subscriptionPrice`, `description`, `fulfilledBy`, `offersSummary.ext`, `offers`, `variants`; no longer `conditionNote`, `offersSummary.url`, `purchaseLimit`, `listedAt`.
- `SearchResult`: new `relatedSearches`, `ext`.
- `Seller`: new `logoUrl`, `productCount`; no longer `detailedRatings`.
- `ShippingOption`: new `ext`; no longer `guaranteedDays`, `membership`, `tracking`.
- `SocialMedia`: new `id`, `title`, `hasAudio`, `tags`, `captions`.
- `Variant`: new `name`, `images`; no longer `sku`, `bulkPrice`, `taxIncluded`.

## 0.2.1

- zod 4 (4.6.7, the version the MCP SDK already uses): zod 3 had a high-severity advisory (GHSA-mrhx-c7xc-m3w5,
  memory exhaustion on oversized collections), so `npm audit` on an install is now clean.

## 0.2.0

- **Code mode is the default.** Three tools instead of thirteen: `search_docs` finds the operations for a task
  (how to call each, every parameter, the cost, the fields returned), `execute` runs TypeScript the model
  writes against a typed `apinoa` client, and `translate_image` stays as it was. A task of many calls is one
  tool call, and only what the code returns comes back into the conversation.
- The code is type-checked against the API's types before it runs: an operation, parameter or field that does
  not exist fails there, before anything is billed.
- It runs in a Deno subprocess that reaches only the apinoa API and reads and writes only its data folder.
  The API key never enters the code. Each run has a unit budget, a time limit and an output cap; answers are
  cached for 10 minutes; `store` keeps data between runs.
- `apinoa.tiktok.media` (the video file) is reachable: `store.saveFile` writes it to disk.
- `APINOA_MCP_MODE=tools` serves the 0.1 tool set; the server falls back to it where Deno cannot run.
- Tool-set answers up to the 100,000-character cap now stay in the conversation in Claude Code
  (`anthropic/maxResultSizeChars`) instead of being moved to a file the model may have no tool to read.

## 0.1.1

- A social post's media keeps its main file, thumbnail and size, but no longer lists every rendition
  of it. A Threads search answer is about a quarter of its old size, so it fits the model's context.
- An answer over the size limit keeps whole items and stays valid JSON, with a note on how many items
  were left out. It used to be cut mid-JSON.
- First release published from GitHub Actions, with npm provenance.

## 0.1.0

First release.
