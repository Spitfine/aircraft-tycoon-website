let markdownLibrary;

export default function (eleventyConfig) {
  eleventyConfig.amendLibrary("md", (library) => {
    markdownLibrary = library;
  });

  eleventyConfig.addFilter("renderMarkdown", (value = "") => {
    if (!markdownLibrary) {
      throw new Error("Eleventy Markdown library is not available.");
    }

    return markdownLibrary.render(value.trim());
  });

  eleventyConfig.addCollection("publishedDevelopmentUpdates", (collectionApi) =>
    collectionApi
      .getFilteredByGlob("content/development-updates/*.md")
      .filter((item) => item.data.update?.status === "published")
      .sort((left, right) =>
        right.data.update.publicationDate.localeCompare(left.data.update.publicationDate)
      )
  );

  eleventyConfig.addPassthroughCopy("assets");

  return {
    dir: {
      input: "content",
      includes: "../_includes",
      output: "_site"
    },
    templateFormats: ["md", "njk"],
    markdownTemplateEngine: "njk"
  };
}
