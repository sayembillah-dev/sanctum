"use client";

import { AntdRegistry } from "@ant-design/nextjs-registry";
import { ConfigProvider, theme } from "antd";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AntdRegistry>
      <ConfigProvider
        theme={{
          algorithm: theme.darkAlgorithm,
          token: {
            colorPrimary: "#6366f1",
            borderRadius: 10,
            colorBgBase: "#0a0a18",
          },
        }}
      >
        {children}
      </ConfigProvider>
    </AntdRegistry>
  );
}
