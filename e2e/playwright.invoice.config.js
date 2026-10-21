import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'./tests',testMatch:'invoice-assets.spec.js',projects:['chromium','firefox','webkit'].flatMap(browserName=>[1280,390].map(width=>({name:browserName+'-'+width,use:{browserName,viewport:{width,height:900}}}))) });
