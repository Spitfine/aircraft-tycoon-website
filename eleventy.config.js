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

  eleventyConfig.addPassthroughCopy("assets");
  eleventyConfig.addPassthroughCopy("index.html");
  eleventyConfig.addPassthroughCopy({ "updates/index.html": "updates/index.html" });

  return {
    dir: {
      input: "content",
      includes: "../_includes",
      output: "_site"
    },
    templateFormats: ["md"],
    markdownTemplateEngine: "njk"
  };
}
