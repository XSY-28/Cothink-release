import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
export function Markdown({ text }) {
  return React.createElement(
    ReactMarkdown,
    {
      remarkPlugins: [remarkGfm, remarkMath],
      rehypePlugins: [
        [rehypeKatex, { throwOnError: false, trust: false, strict: "ignore" }],
      ],
      skipHtml: true,
      components: {
        img: ({ alt }) =>
          React.createElement(
            "span",
            { className: "image-placeholder" },
            `[图片未加载${alt ? "：" + alt : ""}]`,
          ),
        a: ({ href, children }) =>
          React.createElement(
            "a",
            { href, target: "_blank", rel: "noreferrer noopener" },
            children,
          ),
      },
    },
    text || "",
  );
}
