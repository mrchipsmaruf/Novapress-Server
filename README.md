# 🏙️ NovaPress – Public Infrastructure Issue Reporting System

🔗 **Live Website:**  
👉 https://novapress-infra.vercel.app/

---

## 📌 Project Overview

NovaPress is a full-stack web application that allows citizens to report public infrastructure issues such as:

- Potholes  
- Broken streetlights  
- Garbage overflow  
- Water leakage  

The platform enables authorities to manage, verify, and resolve reported issues efficiently.


## 🔐 Authentication & Authorization

- Email & Password authentication  
- Google OAuth login  
- Existing Google users can set a password later  
- JWT-based secure authentication  
- Logged-in users cannot access login/register pages again  
- Blocked users are prevented from accessing the system  

---

## 👥 User Roles

### 👤 Citizen
- Submit infrastructure issues  
- View and manage own issues  
- Make payments (Stripe)  
- Manage profile  

### 🛠️ Staff
- View assigned issues  
- Update issue status  

### 🛡️ Admin
- Manage users  
- Manage all reported issues  
- Full administrative dashboard access  

---

## 🛠️ Issue Management

- Create, view, update, and track issues  
- Issue status lifecycle management  
- Public & dashboard issue views  
- Secure issue access based on role  

---

## 📊 Dashboard System

- Role-based dashboard routing  
- PrivateRoute, AdminRoute, and StaffRoute protection  
- Automatic redirection based on user role  
- Smooth loading state handling  

---

## 💳 Payment Integration

- Stripe payment gateway  
- Secure payment processing  
- Premium feature support  

---

## 🎨 UI / UX

- Fully responsive design (mobile, tablet, desktop)  
- Tailwind CSS & DaisyUI styling  
- Animated banners and background videos  
- Clean and modern user interface  

---

## 🧪 Tech Stack

### Frontend
- React  
- React Router DOM  
- Tailwind CSS  
- DaisyUI  
- React Hook Form  
- TanStack React Query  
- Axios  
- Firebase Authentication  

### Backend
- Node.js  
- Express.js  
- MongoDB  
- Firebase Admin SDK  
- JWT Authentication  

### Payment
- Stripe  


---

## ✅ Key Highlights

- Google users can later log in using email & password  
- Secure role-based routing  
- Clean dashboard separation  
- Production-ready authentication flow  
- Real-world problem-solving application  

---


## 👨‍💻 Developer

**Name:** Al Maruf  
**Project:** NovaPress  

---
