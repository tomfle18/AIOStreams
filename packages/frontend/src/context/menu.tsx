'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import { useMode } from './mode';

const VALID_MENUS = [
  'about',
  'services',
  'addons',
  'filters',
  'sorting',
  'formatter',
  'proxy',
  'miscellaneous',
  'save-install',
];

const PRO_ONLY_MENUS = ['sorting'];

export type MenuId = (typeof VALID_MENUS)[number];

type MenuContextType = {
  selectedMenu: MenuId;
  setSelectedMenu: (menu: MenuId) => void;
  nextMenu: () => void;
  previousMenu: () => void;
  firstMenu: MenuId;
  lastMenu: MenuId;
};

const MenuContext = createContext<MenuContextType>({
  selectedMenu: 'about',
  setSelectedMenu: () => {},
  nextMenu: () => {},
  previousMenu: () => {},
  firstMenu: 'about',
  lastMenu: 'save-install',
});

export function MenuProvider({ children }: { children: React.ReactNode }) {
  const { mode } = useMode();
  const menus = [
    'about',
    'services',
    'addons',
    'filters',
    'sorting',
    'formatter',
    'proxy',
    'miscellaneous',
    'save-install',
  ].filter((menu) => {
    if (mode === 'noob') {
      return !PRO_ONLY_MENUS.includes(menu);
    }
    return true;
  });

  // Get initial menu from URL or default to 'about'
  const initialMenu = (() => {
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      const menu = url.searchParams.get('menu');
      if (menu && menus.includes(menu)) {
        return menu as MenuId;
      }
    }
    return 'about';
  })();

  const [selectedMenu, setInternalSelectedMenu] = useState<MenuId>(initialMenu);

  const setSelectedMenu = (menu: MenuId) => {
    // reset scroll position
    window.scrollTo(0, 0);
    setInternalSelectedMenu(menu);
  };

  const firstMenu = menus[0];
  const lastMenu = menus[menus.length - 1];

  const nextMenu = () => {
    const currentIndex = menus.indexOf(selectedMenu);
    const nextIndex = (currentIndex + 1) % menus.length;
    setSelectedMenu(menus[nextIndex]);
  };

  const previousMenu = () => {
    const currentIndex = menus.indexOf(selectedMenu);
    const previousIndex = (currentIndex - 1 + menus.length) % menus.length;
    setSelectedMenu(menus[previousIndex]);
  };

  // Update URL when menu changes
  useEffect(() => {
    const url = new URL(window.location.href);
    // if menu is not about, add it to the url
    if (selectedMenu !== 'about') {
      url.searchParams.set('menu', selectedMenu);
    } else {
      url.searchParams.delete('menu');
    }
    window.history.replaceState({}, '', url.toString());
  }, [selectedMenu]);

  return (
    <MenuContext.Provider
      value={{
        selectedMenu,
        setSelectedMenu,
        nextMenu,
        previousMenu,
        firstMenu,
        lastMenu,
      }}
    >
      {children}
    </MenuContext.Provider>
  );
}

export const useMenu = () => useContext(MenuContext);
