// src/middleware.js
import { NextResponse } from "next/server";

export function middleware(req) {
    const isPrivateImage = req.nextUrl.pathname.startsWith("/images-private");
    const session = req.cookies.get("session");

    if (isPrivateImage && !session) {
        return NextResponse.redirect(new URL("/login", req.url));
    }

    return NextResponse.next();
}
