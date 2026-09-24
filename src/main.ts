import "./style.css";
import { mountApp } from "./app.js";

const root = document.getElementById("app");
if (root) mountApp(root);
